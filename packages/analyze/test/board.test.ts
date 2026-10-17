import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extract, type Facts } from "@docent/extract";
import { cleanBoard, upgradeBoard, type Board } from "../src/index.ts";

let facts: Facts;
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "docent-board-"));
  cpSync(join(import.meta.dirname, "../../extract/test/fixture"), root, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "Add upload pipeline");
  facts = extract(root);
});

type Spec = Parameters<typeof cleanBoard>[0];
type SpecBeat = Spec["steps"][number]["beats"][number];
const claim = (text: string) => ({ text, label: "confirmed" as const, evidence: [], commit: "", searched: "" });
const beat = (b: Partial<SpecBeat> & Pick<SpecBeat, "kind">): SpecBeat => ({ text: "words", tone: "calm", lines: [], choices: [], claim: null, ...b });

function spec(beats: SpecBeat[]): Spec {
  return {
    title: "t", intro: "i", pitch: "p",
    cards: [{ id: "up", title: "Upload", file: "src/lib/upload.ts", start: 1, end: 4, hot: [2], role: "r", why: claim("w"), say: claim("s") }],
    edges: [],
    steps: [{ card: "up", route: [], beats }],
    tryIt: { intro: "", scenarios: [], toggles: [] },
    defend: [],
  };
}

describe("board tour beats", () => {
  it("keeps sound beats and turns unsound ones into plain talk", () => {
    const b = cleanBoard(spec([
      beat({ kind: "point", lines: [2, 99] }),
      beat({ kind: "point", lines: [99] }),
      beat({ kind: "predict", text: "Which?", choices: [{ text: "a", correct: true }, { text: "b", correct: false }] }),
      beat({ kind: "predict", text: "Two right?", choices: [{ text: "a", correct: true }, { text: "b", correct: true }] }),
      beat({ kind: "predict", text: "Where?", lines: [3] }),
      beat({ kind: "reveal", text: "", claim: claim("Because.") }),
      beat({ kind: "reveal", text: "No claim" }),
      beat({ kind: "say", text: "  " }),
    ]), facts, root, "f", "m");
    const beats = b.steps[0]!.beats;
    expect(beats.map((x) => x.kind)).toEqual(["point", "say", "predict", "say", "predict", "reveal", "say"]);
    expect(beats[0]!.lines).toEqual([2]);
    expect(beats[4]!.lines).toEqual([3]);
    expect(beats[5]!.text).toBe("Because.");
    expect(b.version).toBe(2);
    expect(b.notes.length).toBe(3);
  });

  it("upgrades a board written before beats: each narration becomes one beat", () => {
    const old = { version: 1, steps: [{ card: "", route: [], text: "Why does it retry?" }] } as unknown as Board;
    const up = upgradeBoard(old);
    expect(up.version).toBe(2);
    expect(up.steps[0]!.beats).toEqual([{ kind: "say", text: "Why does it retry?", tone: "curious", lines: [], choices: [], claim: null }]);
  });
});
