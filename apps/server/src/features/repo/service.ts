import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extract, git, isGitRepo, listPaths, loadCachedFacts, repoCacheDir, saveFacts, type Facts } from "@docent/extract";

/** Agent state changes constantly and says nothing about the code. */
const BOOKKEEPING = /^(\.wolf|\.claude|\.cursor|\.codex|\.agents)\//;

/**
 * Owns one repo's facts: loads them from the cache, re-reads the repo when asked,
 * and can tell whether the code moved on since the facts were taken.
 */
export class RepoService {
  readonly root: string;
  facts: Facts;
  private fingerprint: string;
  extracting = false;
  private listeners = new Set<() => void>();

  private constructor(root: string, facts: Facts, fingerprint: string) {
    this.root = root;
    this.facts = facts;
    this.fingerprint = fingerprint;
  }

  static open(repo: string, log: (line: string) => void = () => {}): RepoService {
    const root = resolve(repo);
    const cached = loadCachedFacts(root);
    const meta = readMeta(root);
    if (cached && meta) return new RepoService(root, cached, meta.fingerprint);
    const fingerprint = currentFingerprint(root);
    const facts = extract(root, { onStage: (stage) => log(stage) });
    saveFacts(root, facts);
    writeMeta(root, fingerprint);
    return new RepoService(root, facts, fingerprint);
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

  reextract(): void {
    this.extracting = true;
    try {
      const fingerprint = currentFingerprint(this.root);
      this.facts = extract(this.root);
      saveFacts(this.root, this.facts);
      writeMeta(this.root, fingerprint);
      this.fingerprint = fingerprint;
      for (const listener of this.listeners) listener();
    } finally {
      this.extracting = false;
    }
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
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
