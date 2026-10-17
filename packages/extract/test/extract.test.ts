import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { connections, extract, findSymbols, type Facts } from "../src/index.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

describe("extract on a small fixture", () => {
  let root: string;
  let facts: Facts;
  const fn = (name: string) => connections(facts, findSymbols(facts, name)[0]!);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "docent-fixture-"));
    cpSync(join(import.meta.dirname, "fixture"), root, { recursive: true });
    // Committed build output, as some repos have: it must never reach the facts.
    mkdirSync(join(root, "dist/assets"), { recursive: true });
    writeFileSync(join(root, "dist/assets/index.js"), "export function bundled() { return 1; }\n");
    writeFileSync(join(root, "src/vendor.min.js"), "export function minified() { return 1; }\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "Add upload pipeline");
    // A class that existed and was removed, and a doc that still names it next to a browser API.
    writeFileSync(join(root, "src/lib/legacy.ts"), "export class LegacyUploadError extends Error {}\n");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "Add the legacy error");
    git(root, "rm", "-q", "src/lib/legacy.ts");
    writeFileSync(join(root, "NOTES.md"), "Failures throw `LegacyUploadError`. The preview sets `innerHTML` directly.\n");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "Drop the legacy error");
    facts = extract(root);
  });

  it("flags a doc naming code that was removed, with the commit that removed it, and ignores names the code never declared", () => {
    const notes = facts.docs.find((d) => d.path === "NOTES.md")!;
    const missing = notes.mentions.filter((m) => m.missing);
    expect(missing.map((m) => m.text)).toEqual(["LegacyUploadError"]);
    expect(missing[0]!.missingKind).toBe("name");
    expect(facts.commits.find((c) => c.sha.startsWith(missing[0]!.removedIn!.sha))?.subject).toBe("Drop the legacy error");
  });

  it("follows a call through a barrel re-export to the real function", () => {
    const callers = fn("upload").callers.map((e) => [e.from.split("#")[1], e.confidence]);
    expect(callers).toContainEqual(["Page.onSave", "confirmed"]);
  });

  it("resolves a method returned as an object shorthand to the local function", () => {
    const callees = fn("upload").callees.map((e) => e.to);
    expect(callees).toContain("src/lib/api.ts#createClient.post");
    expect(callees).toContain("src/lib/upload.ts#helper");
  });

  it("marks a call through an interface as inferred, not confirmed", () => {
    const save = fn("upload").callees.find((e) => e.to.endsWith("Store.save"));
    expect(save?.confidence).toBe("inferred");
  });

  it("records components rendering components", () => {
    expect(fn("Page").callees.some((e) => e.kind === "renders" && e.to === "src/ui/Button.tsx#Button")).toBe(true);
  });

  it("maps a test case to the function it exercises", () => {
    expect(fn("upload").tests.map((t) => t.test.id)).toEqual(["src/lib/upload.test.ts#test:upload > posts the file"]);
  });

  it("leaves build output and minified bundles out", () => {
    expect(facts.files.map((f) => f.path).filter((p) => p.startsWith("dist/") || p.endsWith(".min.js"))).toEqual([]);
  });

  it("finds the browser entry and the file nothing imports", () => {
    expect(facts.entries.some((e) => e.kind === "browser-entry" && e.file === "src/main.tsx")).toBe(true);
    expect(facts.unreferenced.map((u) => u.file)).toEqual(["src/orphan.ts"]);
  });

  it("flags a doc that names a path which doesn't exist", () => {
    const readme = facts.docs.find((d) => d.path === "README.md")!;
    expect(readme.mentions.find((m) => m.text === "src/old/thing.ts")?.missing).toBe(true);
    expect(readme.mentions.find((m) => m.text === "upload")?.target).toBe("src/lib/upload.ts#upload");
  });

  it("collects env vars, markers and history", () => {
    expect(facts.env.map((e) => e.name)).toEqual(["VITE_API_URL"]);
    expect(facts.markers[0]).toMatchObject({ kind: "TODO", file: "src/lib/upload.ts" });
    expect(facts.commits.map((c) => c.subject)).toContain("Add upload pipeline");
  });

  it("leaves the repo untouched", () => {
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});

describe("extract on a folder without git", () => {
  it("lists files (respecting .gitignore), builds the graph, and says plainly there is no history", () => {
    const root = mkdtempSync(join(tmpdir(), "docent-nogit-"));
    cpSync(join(import.meta.dirname, "fixture"), root, { recursive: true });
    mkdirSync(join(root, "ignored"), { recursive: true });
    writeFileSync(join(root, "ignored/skip.ts"), "export const skipped = 1;\n");
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    const facts = extract(root);
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(facts.files.some((f) => f.path === "src/lib/upload.ts")).toBe(true);
    expect(facts.files.some((f) => f.path.startsWith("ignored/"))).toBe(false);
    expect(facts.symbols.length).toBeGreaterThan(0);
    expect(facts.commits).toEqual([]);
    expect(facts.repo.head).toBeNull();
    expect(facts.warnings.join(" ")).toMatch(/No git history/);
  });
});
