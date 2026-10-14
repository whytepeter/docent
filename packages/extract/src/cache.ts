import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Facts } from "./types.ts";

/** Everything Docent stores about a repo lives here, never inside the repo itself. */
export function repoCacheDir(repo: string): string {
  const root = resolve(repo);
  const dir = join(homedir(), ".docent", "repos", `${basename(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const factsFile = (repo: string) => join(repoCacheDir(repo), "facts.json");

export function loadCachedFacts(repo: string): Facts | null {
  const file = factsFile(repo);
  if (!existsSync(file)) return null;
  try {
    const facts = JSON.parse(readFileSync(file, "utf8")) as Facts;
    return facts.version === 1 ? facts : null;
  } catch {
    return null;
  }
}

export function saveFacts(repo: string, facts: Facts): string {
  const file = factsFile(repo);
  writeFileSync(file, JSON.stringify(facts));
  return file;
}
