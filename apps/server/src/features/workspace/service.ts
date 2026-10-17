import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Hono } from "hono";
import type { RecentRepo, RepoSource, Workspace as WorkspaceState } from "@docent/contracts";
import { RepoService } from "../repo/index.ts";
import { checkoutSource } from "./github.ts";
import { unzip } from "./zip.ts";

const RECENT_FILE = join(homedir(), ".docent", "recent.json");
const MAX_RECENT = 8;
/** Zips Docent unpacked, one folder each, named after the zip. */
export const IMPORTS = join(homedir(), ".docent", "imports");
/** The most a zip may weigh before it's unpacked. */
export const MAX_ZIP_BYTES = 300 * 1024 * 1024;

/**
 * Which codebase the app is showing. The user can open another folder at any time;
 * each open builds a fresh set of routes over that repo's facts.
 */
export class Workspace {
  repo: RepoService | null = null;
  app: Hono | null = null;
  private source: RepoSource | undefined;

  constructor(private readonly build: (repo: RepoService) => Hono, private readonly log: (line: string) => void = () => {}) {}

  state(): WorkspaceState {
    return {
      current: this.repo ? { root: this.repo.root, name: basename(this.repo.root), source: this.source } : null,
      recent: readRecent().filter((r) => r.root !== this.repo?.root && isDir(r.root)),
    };
  }

  /**
   * Opens a folder: reads it (or loads its cached facts) and points every route at it.
   * Where it came from is remembered with it: a GitHub checkout says so itself, a zip is told by the import.
   */
  open(path: string, source?: RepoSource): WorkspaceState {
    const root = resolve(path.trim().replace(/^~(?=$|\/)/, homedir()));
    // A .zip on disk (picked in the dialog or pasted) opens the way a dropped one does.
    if (/\.zip$/i.test(root) && isFile(root)) {
      if (statSync(root).size > MAX_ZIP_BYTES) throw new Error(`That zip is over ${MAX_ZIP_BYTES / 1024 / 1024} MB, the most Docent opens.`);
      return this.importZip(readFileSync(root), basename(root));
    }
    if (!isDir(root)) throw new Error(`Not a folder: ${root}`);
    const repo = RepoService.open(root, this.log);
    this.repo = repo;
    this.app = this.build(repo);
    this.source = source ?? checkoutSource(root) ?? readRecent().find((r) => r.root === root)?.source ?? { kind: "folder" };
    remember(root, this.source);
    return this.state();
  }

  /** Unpacks a zip into ~/.docent/imports/<name> (replacing an earlier import of the same name) and opens it. */
  importZip(buf: Buffer, fileName: string): WorkspaceState {
    const name = fileName.replace(/^.*[\\/]/, "").replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 80) || "project";
    mkdirSync(IMPORTS, { recursive: true });
    const tmp = join(IMPORTS, `.partial-${randomUUID()}`);
    try {
      unzip(buf, tmp);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    const dest = join(IMPORTS, name);
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
    return this.open(dest, { kind: "zip", file: fileName.replace(/^.*[\\/]/, "") });
  }
}

/**
 * Where a folder dropped on the page lives. Browsers hand over only its name and what's inside, never the path,
 * so this looks for folders with that name (recent ones, then Spotlight, then a shallow walk of home)
 * and keeps those that hold the same top-level entries. Most likely first.
 */
export async function findDropped(name: string, children: string[]): Promise<string[]> {
  const holds = (dir: string) => children.every((c) => existsSync(join(dir, c)));
  const found = new Set<string>();
  for (const r of readRecent()) if (basename(r.root) === name) found.add(r.root);
  for (const p of await spotlight(name)) found.add(p);
  if (![...found].some((p) => isDir(p) && holds(p))) for (const p of walkHome(name)) found.add(p);
  return [...found].filter((p) => isDir(p) && holds(p) && !/\/(node_modules|\.Trash|Library)\//.test(p)).slice(0, 6);
}

function spotlight(name: string): Promise<string[]> {
  if (process.platform !== "darwin") return Promise.resolve([]);
  const query = `kMDItemFSName == "${name.replace(/["\\*]/g, "\\$&")}" && kMDItemContentType == "public.folder"`;
  return new Promise((ok) => {
    execFile("mdfind", ["-onlyin", homedir(), query], { timeout: 4000 }, (error, stdout) => ok(error ? [] : stdout.split("\n").filter(Boolean)));
  });
}

/** Breadth-first under home, skipping hidden and dependency folders, capped so a drop never hangs. */
function walkHome(name: string, maxDepth = 4, maxDirs = 15000): string[] {
  const hits: string[] = [];
  let queue = [homedir()];
  let seen = 0;
  for (let depth = 0; depth < maxDepth && queue.length && seen < maxDirs; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || e.name === "Library") continue;
        const p = join(dir, e.name);
        if (e.name === name) hits.push(p);
        next.push(p);
        if (++seen >= maxDirs) break;
      }
    }
    queue = next;
  }
  return hits;
}

/**
 * The native macOS open dialog, shown over the browser: a project folder or a .zip, in one dialog.
 * AppleScript's dialogs pick a folder or a file, never either, so this drives NSOpenPanel through JXA.
 * Resolves null when the user cancels.
 */
const PICK_SCRIPT = `
ObjC.import("AppKit");
const panel = $.NSOpenPanel.openPanel;
panel.canChooseDirectories = true;
panel.canChooseFiles = true;
panel.allowsMultipleSelection = false;
panel.allowedFileTypes = $(["zip"]);
panel.message = $("Choose a codebase: a project folder or a .zip");
panel.prompt = $("Open");
$.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
panel.runModal == $.NSModalResponseOK ? panel.URLs.objectAtIndex(0).path.js : "";
`;

export function pickFolder(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.reject(new Error("The open dialog is macOS only. Paste the folder’s path instead."));
  return new Promise((ok, fail) => {
    execFile("osascript", ["-l", "JavaScript", "-e", PICK_SCRIPT], (error, stdout, stderr) => {
      if (!error) return ok(stdout.trim().replace(/\/$/, "") || null);
      if (/-128|cancel/i.test(stderr)) return ok(null);
      fail(new Error(stderr.trim() || error.message));
    });
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readRecent(): RecentRepo[] {
  try {
    return JSON.parse(readFileSync(RECENT_FILE, "utf8")) as RecentRepo[];
  } catch {
    return [];
  }
}

function remember(root: string, source: RepoSource): void {
  const next = [{ root, name: basename(root), openedAt: new Date().toISOString(), source }, ...readRecent().filter((r) => r.root !== root)].slice(0, MAX_RECENT);
  mkdirSync(dirname(RECENT_FILE), { recursive: true });
  writeFileSync(RECENT_FILE, JSON.stringify(next, null, 2));
}
