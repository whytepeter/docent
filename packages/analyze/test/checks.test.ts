import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extract, type Facts } from "@docent/extract";
import { applyReview, makeChecker, validateDiscovery, type AnalysisClaim } from "../src/index.ts";

/** A made-up payments key, built from parts so secret scanners don't mistake this test for a leak. */
const FAKE_KEY = ["sk", "live", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("_");

let root: string;
let facts: Facts;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "docent-analyze-"));
  cpSync(join(import.meta.dirname, "../../extract/test/fixture"), root, { recursive: true });
  // A hardcoded key, as agent-written code sometimes has. Assembled here so no key-shaped string sits in this file.
  writeFileSync(join(root, "src/lib/keys.ts"), `export const PAYMENTS = "${FAKE_KEY}";\n`);
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "Add upload pipeline");
  facts = extract(root);
});

describe("discovery clean-up", () => {
  it("drops invented paths, de-duplicates files, and accounts for every source file", () => {
    const map = validateDiscovery({
      features: [
        { id: "Upload", name: "Upload", summary: "s", kind: "user-facing", entryPoints: ["src/lib/upload.ts#upload", "src/nope.ts#x"], files: ["src/lib/upload.ts", "src/made/up.ts", "src/ui/Page.tsx"], reason: "r", confidence: "high" },
        { id: "upload", name: "Page again", summary: "s", kind: "user-facing", entryPoints: [], files: ["src/ui/Page.tsx", "src/ui/Button.tsx"], reason: "r", confidence: "low" },
      ],
      unassigned: [],
    }, facts, { model: "m", provider: "claude-code" });
    expect(map.features.map((f) => f.id)).toEqual(["upload", "upload-2"]);
    expect(map.features[0]!.files).toEqual(["src/lib/upload.ts", "src/ui/Page.tsx"]);
    expect(map.features[0]!.entryPoints).toEqual(["src/lib/upload.ts#upload"]);
    expect(map.features[1]!.files).toEqual(["src/ui/Button.tsx"]);
    expect(map.notes.some((n) => n.includes("src/made/up.ts"))).toBe(true);
    expect(map.unassigned.map((u) => u.file)).toContain("src/orphan.ts");
  });
});

describe("citation check", () => {
  const base = { kind: "behavior" as const, commit: "", searched: "" };
  it("keeps a confirmed claim whose lines contain what it names", () => {
    const out = makeChecker(root, facts).apply({
      summary: "", analogy: "", status: "working", statusReason: "", flow: [], issues: [],
      claims: [{ ...base, text: "upload calls helper", label: "confirmed", evidence: [{ file: "src/lib/upload.ts", start: 7, end: 12, mentions: ["helper(1)", "createClient()"] }] }],
    });
    expect(out.claims[0]!.label).toBe("confirmed");
  });
  it("demotes a confirmed claim whose citation doesn't hold, and says why", () => {
    const out = makeChecker(root, facts).apply({
      summary: "", analogy: "", status: "working", statusReason: "", flow: [], issues: [],
      claims: [
        { ...base, text: "wrong lines", label: "confirmed", evidence: [{ file: "src/lib/upload.ts", start: 1, end: 2, mentions: ["client.post"] }] },
        { ...base, text: "no such file", label: "confirmed", evidence: [{ file: "src/ghost.ts", start: 1, end: 2, mentions: [] }] },
        { ...base, text: "out of range", label: "confirmed", evidence: [{ file: "src/lib/upload.ts", start: 400, end: 410, mentions: [] }] },
      ],
    });
    expect(out.claims.map((c) => c.label)).toEqual(["inferred", "inferred", "inferred"]);
    expect(out.claims[0]!.checkNote).toContain("client.post");
    expect(out.claims[1]!.checkNote).toContain("no file");
    expect(out.claims[2]!.claimedLabel).toBe("confirmed");
  });
  it("demotes a confirmed claim whose citation names nothing, or that cites nothing and searched nothing", () => {
    const out = makeChecker(root, facts).apply({
      summary: "", analogy: "", status: "working", statusReason: "", flow: [], issues: [],
      claims: [
        { ...base, text: "lines exist, names nothing", label: "confirmed", evidence: [{ file: "src/lib/upload.ts", start: 7, end: 12, mentions: [" "] }] },
        { ...base, text: "no evidence at all", label: "confirmed", evidence: [] },
        { ...base, text: "nothing retries the upload", label: "confirmed", evidence: [], searched: "grep retry|attempt in src/" },
      ],
    });
    expect(out.claims.map((c) => c.label)).toEqual(["inferred", "inferred", "confirmed"]);
    expect(out.claims[0]!.checkNote).toContain("nothing to look for");
  });
  it("never accepts a secret as evidence, and never stores one in a claim", () => {
    const out = makeChecker(root, facts).apply({
      summary: "", analogy: "", status: "working", statusReason: "", flow: [], issues: [],
      claims: [{ ...base, text: `payments use ${FAKE_KEY}`, label: "confirmed", evidence: [{ file: "src/lib/keys.ts", start: 1, end: 1, mentions: ["PAYMENTS"] }] }],
    });
    expect(out.claims[0]!.label).toBe("inferred");
    expect(out.claims[0]!.checkNote).toContain("secret");
    expect(out.claims[0]!.text).not.toContain(FAKE_KEY);
  });
  it("accepts a record only when the commit exists", () => {
    const sha = facts.commits[0]!.sha;
    const out = makeChecker(root, facts).apply({
      summary: "", analogy: "", status: "working", statusReason: "", flow: [], issues: [],
      claims: [
        { kind: "why", text: "added with the pipeline", label: "record", commit: sha, searched: "", evidence: [] },
        { kind: "why", text: "made up", label: "record", commit: "deadbee", searched: "", evidence: [] },
      ],
    });
    expect(out.claims.map((c) => c.label)).toEqual(["record", "unknown"]);
  });
});

describe("second reader", () => {
  const claim = (label: AnalysisClaim["label"], text: string): AnalysisClaim => ({ kind: "behavior", text, label, commit: "", searched: "", evidence: [] });
  it("keeps only upheld claims, demotes the rest, and never touches guesses", () => {
    const claims = [claim("confirmed", "a"), claim("confirmed", "b"), claim("record", "c"), claim("confirmed", "d"), claim("inferred", "e")];
    const out = applyReview(claims, [
      { id: 0, verdict: "upheld", reason: "line 9 calls it" },
      { id: 1, verdict: "unsure", reason: "the cited lines don't show the retry" },
      { id: 2, verdict: "refuted", reason: "the commit is about styling" },
      { id: 4, verdict: "upheld", reason: "not asked" },
    ]);
    expect(out.map((c) => c.label)).toEqual(["confirmed", "inferred", "unknown", "inferred", "inferred"]);
    expect(out[0]!.review?.reason).toBe("line 9 calls it");
    expect(out[2]!.claimedLabel).toBe("record");
    expect(out[2]!.checkNote).toContain("disputes");
    expect(out[3]!.checkNote).toContain("no verdict");
    expect(out[4]!.review).toBeUndefined();
  });
});
