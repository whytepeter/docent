import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extract, type Facts } from "@docent/extract";
import { cleanEpisode } from "../src/index.ts";
import type { EpisodeSpec } from "../src/schemas.ts";

let facts: Facts;
beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "docent-ep-"));
  cpSync(join(import.meta.dirname, "../../extract/test/fixture"), root, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "Add upload pipeline");
  facts = extract(root);
});

const claim = (text: string) => ({ text, label: "confirmed" as const, evidence: [], commit: "", searched: "" });

describe("episode clean-up", () => {
  it("keeps only boxes that stand for real code, and links, packets and code ranges that join them", () => {
    const spec: EpisodeSpec = {
      title: "t", intro: "i", analogy: "a",
      cast: [
        { id: "page", title: "Page", kind: "screen", lane: 0, file: "src/ui/Page.tsx", symbol: "", start: 1, end: 3 },
        { id: "upload", title: "Upload", kind: "code", lane: 1, file: "src/lib/upload.ts", symbol: "src/lib/upload.ts#nope", start: 1, end: 999 },
        { id: "ghost", title: "Ghost", kind: "code", lane: 1, file: "src/ghost.ts", symbol: "", start: 1, end: 2 },
        { id: "api", title: "The API", kind: "external", lane: 2, file: "", symbol: "", start: 0, end: 0 },
      ],
      links: [
        { id: "l1", from: "page", to: "upload", label: "files" },
        { id: "l2", from: "upload", to: "ghost", label: "x" },
        { id: "l3", from: "upload", to: "api", label: "post" },
      ],
      scenes: [{
        title: "s", objective: "o",
        steps: [{
          boxes: ["page", "ghost"], links: ["l1", "l2"],
          packets: [{ link: "l1", label: "files", back: false, bad: false }, { link: "l2", label: "x", back: false, bad: false }],
          code: { file: "src/nope.ts", start: 1, end: 2 }, say: "say", tone: "calm", caption: "cap", claim: claim("a"),
          predict: { question: "q", options: [{ text: "x", correct: true }], reveal: claim("b") },
        }],
      }],
      selfCheck: [{ question: "q1", answer: claim("c") }],
      exercise: { task: "t", hint: "h", check: "c" },
    };
    const { episode, claims } = cleanEpisode(spec, facts);
    expect(episode.cast.map((c) => c.id)).toEqual(["page", "upload", "api"]);
    expect(episode.cast[1]).toMatchObject({ symbol: "", start: 0, end: 0 });
    expect(episode.links.map((l) => l.id)).toEqual(["l1", "l3"]);
    const step = episode.scenes[0]!.steps[0]!;
    expect(step.boxes).toEqual(["page"]);
    expect(step.packets.map((p) => p.link)).toEqual(["l1"]);
    expect(step.code).toBeNull();
    expect(claims.map((c) => c.text)).toEqual(["a", "b", "c"]);
    expect(episode.notes.join(" ")).toContain("src/ghost.ts");
  });
});
