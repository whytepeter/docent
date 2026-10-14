import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
