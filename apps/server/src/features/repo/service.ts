import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join, resolve, sep } from "node:path";
import { extract, git, isGitRepo, listPaths, loadCachedFacts, repoCacheDir, saveFacts, type ExtractCache, type Facts } from "@docent/extract";

/** Agent state changes constantly and says nothing about the code. */
const BOOKKEEPING = /^(\.wolf|\.claude|\.cursor|\.codex|\.agents)\//;
/**
 * Changes the watcher ignores: installed packages, build output, agent state, and git's own files, except
 * the ones a commit, checkout or pull moves (HEAD and the refs).
 */
const UNWATCHED = /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|__pycache__|\.venv|venv|\.pytest_cache|\.mypy_cache)(\/|$)|^(\.wolf|\.claude|\.cursor|\.codex|\.agents)(\/|$)|^\.git\/(?!HEAD$|refs\/|packed-refs$)/;
/** How long edits must settle before the code is read again (a save often touches a file twice). */
const SETTLE_MS = 1000;

/**
 * Owns one repo's facts: loads them from the cache, re-reads the repo when asked,
 * and can tell whether the code moved on since the facts were taken.
 */
export class RepoService {
  readonly root: string;
  facts: Facts;
  private fingerprint: string;
  extracting = false;
  /** Moves on every time the facts are read again, so open screens know to check their boards. */
  version = 0;
  private listeners = new Set<() => void>();
  private watcher: FSWatcher | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private rereadAgain = false;
  /** The TypeScript project from the last read, kept so a re-read walks only what changed. */
  private cache: ExtractCache = {};

  private constructor(root: string, facts: Facts, fingerprint: string, cache: ExtractCache = {}) {
    this.root = root;
    this.facts = facts;
    this.fingerprint = fingerprint;
    this.cache = cache;
  }

  static async open(repo: string, log: (line: string) => void = () => {}): Promise<RepoService> {
    const root = resolve(repo);
    const cached = loadCachedFacts(root);
    const meta = readMeta(root);
    const fingerprint = currentFingerprint(root);
    // Cached facts are used only while the code is as they describe it; otherwise the repo is read again.
    if (cached && meta && meta.fingerprint === fingerprint) return new RepoService(root, cached, meta.fingerprint);
    if (cached) log("The code changed since it was last read; reading it again");
    const cache: ExtractCache = {};
    const facts = await extract(root, { onStage: (stage) => log(stage), cache });
    saveFacts(root, facts);
    writeMeta(root, fingerprint);
    return new RepoService(root, facts, fingerprint, cache);
  }

  /** True when the working tree no longer matches what the facts describe. */
  isStale(): boolean {
    return currentFingerprint(this.root) !== this.fingerprint;
  }

  head(): string | null {
    try {
      return git(this.root, ["rev-parse", "--short", "HEAD"]).trim();
    } catch {
      return null;
    }
  }

  async reextract(): Promise<void> {
    this.extracting = true;
    try {
      const fingerprint = currentFingerprint(this.root);
      this.facts = await extract(this.root, { cache: this.cache });
      saveFacts(this.root, this.facts);
      writeMeta(this.root, fingerprint);
      this.fingerprint = fingerprint;
      this.version++;
      for (const listener of this.listeners) listener();
    } finally {
      this.extracting = false;
    }
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /**
   * Watches the folder while it's open: once edits settle, the code is read again in the background, so boards
   * say "Code changed" without being reopened. Where the system can't watch a folder tree, staleness is still
   * checked when a board opens or is drawn.
   */
  watch(log: (line: string) => void = () => {}): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
        const path = String(name ?? "").split(sep).join("/");
        if (!path || UNWATCHED.test(path)) return;
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => void this.settle(log), SETTLE_MS);
      });
      this.watcher.on("error", () => this.unwatch());
    } catch {
      this.watcher = null;
    }
  }

  unwatch(): void {
    clearTimeout(this.settleTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  /** Reads the code again if it really changed (the fingerprint decides); edits during a read get one more. */
  private async settle(log: (line: string) => void): Promise<void> {
    if (this.extracting) {
      this.rereadAgain = true;
      return;
    }
    try {
      if (!this.isStale()) return;
      log("The code changed; reading it again");
      await this.reextract();
    } catch (error) {
      log(`Couldn't read the code again: ${(error as Error).message}`);
    }
    if (this.rereadAgain) {
      this.rereadAgain = false;
      void this.settle(log);
    }
  }
}

function currentFingerprint(root: string): string {
  const hash = createHash("sha1");
  // Without git (an unpacked zip), the files themselves are the fingerprint.
  if (!isGitRepo(root)) {
    for (const path of listPaths(root)) {
      if (BOOKKEEPING.test(path)) continue;
      try {
        const st = statSync(join(root, path));
        hash.update(`${path}\0${st.size}\0${st.mtimeMs}\n`);
      } catch {
        /* gone since it was listed */
      }
    }
    return hash.digest("hex");
  }
  try {
    hash.update(git(root, ["rev-parse", "HEAD"]));
    for (const line of git(root, ["status", "--porcelain", "-uall"]).split("\n")) {
      const path = line.slice(3).trim();
      if (!path || BOOKKEEPING.test(path)) continue;
      hash.update(line);
      const full = join(root, path);
      if (existsSync(full)) hash.update(String(statSync(full).mtimeMs));
    }
  } catch {
    hash.update("no-git");
  }
  return hash.digest("hex");
}

const metaFile = (root: string) => join(repoCacheDir(root), "meta.json");
function readMeta(root: string): { fingerprint: string } | null {
  try {
    return JSON.parse(readFileSync(metaFile(root), "utf8")) as { fingerprint: string };
  } catch {
    return null;
  }
}
function writeMeta(root: string, fingerprint: string): void {
  writeFileSync(metaFile(root), JSON.stringify({ fingerprint }));
}
