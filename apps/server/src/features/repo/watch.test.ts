import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RepoService } from "./service.ts";

// Docent keeps a repo's facts under ~/.docent; the test gives it a home of its own.
const home = mkdtempSync(join(tmpdir(), "docent-home-"));
const realHome = process.env.HOME;
beforeAll(() => void (process.env.HOME = home));
afterAll(() => void (process.env.HOME = realHome));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "docent-watch-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "w" }));
  writeFileSync(join(root, "src/a.ts"), "export function a() {\n  return 1;\n}\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return root;
}

const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return ok();
};

describe("watching the open folder", () => {
  it("reads the code again once an edit settles, and ignores changes outside the code", async () => {
    const root = repo();
    const svc = await RepoService.open(root);
    svc.watch();
    try {
      // Installed packages and agent state don't count.
      mkdirSync(join(root, "node_modules/x"), { recursive: true });
      writeFileSync(join(root, "node_modules/x/index.js"), "module.exports = 1;\n");
      mkdirSync(join(root, ".claude"));
      writeFileSync(join(root, ".claude/notes.md"), "hi\n");
      expect(await until(() => svc.version > 0, 2500)).toBe(false);

      writeFileSync(join(root, "src/b.ts"), "import { a } from './a';\nexport const b = () => a();\n");
      expect(await until(() => svc.version > 0, 10_000)).toBe(true);
      expect(svc.facts.symbols.map((s) => s.name)).toContain("b");
      expect(svc.isStale()).toBe(false);
    } finally {
      svc.unwatch();
    }
  }, 20_000);
});
