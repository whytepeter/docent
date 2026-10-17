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
type SpecStep = Spec["steps"][number];
type SpecBeat = SpecStep["beats"][number];
const claim = (text: string) => ({ text, label: "confirmed" as const, evidence: [], commit: "", searched: "" });
const beat = (b: Partial<SpecBeat> & Pick<SpecBeat, "kind">): SpecBeat => ({ text: "words", tone: "calm", lines: [], values: [], claim: null, ...b });
const step = (s: Partial<SpecStep>): SpecStep => ({ part: "flow", card: "up", route: [], hops: [], beats: [beat({ kind: "say" })], ...s });

function spec(steps: SpecStep[]): Spec {
  return {
    title: "t", intro: "i", pitch: "p",
    cards: [
      { id: "page", title: "Page", file: "src/ui/Page.tsx", start: 1, end: 3, hot: [], role: "r", why: claim("w"), say: claim("s") },
      { id: "up", title: "Upload", file: "src/lib/upload.ts", start: 1, end: 4, hot: [2], role: "r", why: claim("w"), say: claim("s") },
    ],
    edges: [{ from: "page", to: "up", label: "files" }],
    steps,
  };
}

describe("board tour", () => {
  it("keeps sound beats and turns unsound ones into plain talk", () => {
    const b = cleanBoard(spec([step({
      beats: [
        beat({ kind: "point", lines: [2, 99], values: [{ line: 2, text: " size = 3 MB " }, { line: 99, text: "off the card" }] }),
        beat({ kind: "point", lines: [99] }),
        beat({ kind: "ask", text: "Why?", tone: "calm" }),
        beat({ kind: "reveal", text: "", lines: [3], claim: claim("Because.") }),
        beat({ kind: "reveal", text: "No claim" }),
        beat({ kind: "say", text: "  " }),
      ],
    })]), facts, root, "f", "m");
    const beats = b.steps[0]!.beats;
    expect(beats.map((x) => x.kind)).toEqual(["point", "say", "ask", "reveal", "say"]);
    expect(beats[0]!.lines).toEqual([2]);
    expect(beats[0]!.values).toEqual([{ line: 2, text: "size = 3 MB" }]);
    expect(beats[2]!.tone).toBe("curious");
    expect(beats[3]).toMatchObject({ text: "Because.", lines: [3] });
    expect(b.version).toBe(3);
  });

  it("keeps a failure only with a path along the board's links, and a why only with a card", () => {
    const hop = (edge: string) => ({ edge, back: false, stat: "500", tone: "bad" as const });
    const b = cleanBoard(spec([
      step({ part: "fail", hops: [hop("page>up")] }),
      step({ part: "fail", hops: [hop("up>nowhere")] }),
      step({ part: "why", card: "" }),
      step({ part: "flow", route: ["page>up", "up>page"] }),
    ]), facts, root, "f", "m");
    expect(b.steps.map((s) => s.part)).toEqual(["fail", "flow", "close", "flow"]);
    expect(b.steps[0]!.hops).toHaveLength(1);
    expect(b.steps[3]!.route).toEqual(["page>up"]);
  });

  it("upgrades an older board: guesses become questions it answers, Try it and Defend it become tour steps", () => {
    const old = {
      version: 2, cards: [], edges: [], notes: [], title: "t", intro: "i", pitch: "p", flowId: "f", generatedAt: "", model: "", status: "checked",
      steps: [
        { card: "", route: [], beats: [{ kind: "say", text: "Picture this.", tone: "calm", lines: [], choices: [], claim: null }] },
        { card: "up", route: [], beats: [
          { kind: "predict", text: "Where does it stall?", tone: "curious", lines: [81], choices: [], claim: null },
          { kind: "reveal", text: "The watchdog.", tone: "emphatic", lines: [], choices: [], claim: claim("The watchdog.") },
        ] },
        { card: "", route: [], text: "Now you can say it." },
      ],
      tryIt: { intro: "", toggles: [], scenarios: [
        { label: "Send a valid upload", hops: [{ edge: "page>up", back: false, stat: "ok", tone: "ok" }], result: claim("fine") },
        { label: "Storage refuses", hops: [{ edge: "page>up", back: false, stat: "500", tone: "bad" }], result: claim("It fails.") },
      ] },
      defend: [{ q: "Why one retry?", card: "up", lines: [3], answer: claim("To bound it."), breaks: "Loops forever." }],
    } as unknown as Board;
    const b = upgradeBoard(old);
    expect(b.version).toBe(3);
    expect(b.steps.map((s) => s.part)).toEqual(["intro", "flow", "fail", "why", "close"]);
    expect(b.steps[1]!.beats.map((x) => [x.kind, x.lines])).toEqual([["ask", []], ["reveal", [81]]]);
    expect(b.steps[2]).toMatchObject({ card: "up", beats: [{ kind: "say", text: "Here's one that goes wrong: Storage refuses." }, { kind: "reveal", text: "It fails." }] });
    expect(b.steps[3]!.beats.map((x) => x.text)).toEqual(["Why one retry?", "To bound it.", "Without it: Loops forever."]);
    expect(b.steps[4]!.beats[0]!.text).toBe("Now you can say it.");
    expect("tryIt" in b || "defend" in b).toBe(false);
  });
});
