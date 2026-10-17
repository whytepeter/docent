import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Hono } from "hono";
import type { RecentRepo, Workspace as WorkspaceState } from "@docent/contracts";
import { RepoService } from "../repo/index.ts";

const RECENT_FILE = join(homedir(), ".docent", "recent.json");
const MAX_RECENT = 8;

/**
 * Which codebase the app is showing. The user can open another folder at any time;
 * each open builds a fresh set of routes over that repo's facts.
 */
export class Workspace {
  repo: RepoService | null = null;
  app: Hono | null = null;

  constructor(private readonly build: (repo: RepoService) => Hono, private readonly log: (line: string) => void = () => {}) {}

  state(): WorkspaceState {
    return {
      current: this.repo ? { root: this.repo.root, name: basename(this.repo.root) } : null,
      recent: readRecent().filter((r) => r.root !== this.repo?.root && isDir(r.root)),
    };
  }

  /** Opens a folder: reads it (or loads its cached facts) and points every route at it. */
  open(path: string): WorkspaceState {
    const root = resolve(path.trim().replace(/^~(?=$|\/)/, homedir()));
    if (!isDir(root)) throw new Error(`Not a folder: ${root}`);
    const repo = RepoService.open(root, this.log);
    this.repo = repo;
    this.app = this.build(repo);
    remember(root);
    return this.state();
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

/** The native macOS folder dialog, shown over the browser. Resolves null when the user cancels. */
export function pickFolder(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.reject(new Error("The folder dialog is macOS only. Paste the folder's path instead."));
  const script = `tell application (path to frontmost application as text) to POSIX path of (choose folder with prompt "Choose a codebase for Docent")`;
  return new Promise((ok, fail) => {
    execFile("osascript", ["-e", script], (error, stdout, stderr) => {
      if (!error) return ok(stdout.trim().replace(/\/$/, "") || null);
      if (/-128|cancel/i.test(stderr)) return ok(null);
      fail(new Error(stderr.trim() || error.message));
    });
  });
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

function remember(root: string): void {
  const next = [{ root, name: basename(root), openedAt: new Date().toISOString() }, ...readRecent().filter((r) => r.root !== root)].slice(0, MAX_RECENT);
  mkdirSync(dirname(RECENT_FILE), { recursive: true });
  writeFileSync(RECENT_FILE, JSON.stringify(next, null, 2));
}
