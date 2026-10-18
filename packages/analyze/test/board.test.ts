import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extract, type Facts } from "@docent/extract";
import { cleanBoard, flowTests, upgradeBoard, valueFits, type Board } from "../src/index.ts";

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
const beat = (b: Partial<SpecBeat> & Pick<SpecBeat, "kind">): SpecBeat => ({ text: "words", tone: "calm", lines: [], values: [], focus: [], claim: null, analogy: false, ...b });
const step = (s: Partial<SpecStep>): SpecStep => ({ part: "flow", card: "up", route: [], hops: [], beats: [beat({ kind: "say" })], state: [], touches: [], ...s });

function spec(steps: SpecStep[]): Spec {
  return {
    title: "t", intro: "i", pitch: "p",
    cards: [
      { id: "page", title: "Page", file: "src/ui/Page.tsx", start: 1, end: 3, hot: [], role: "r", why: claim("w"), say: claim("s") },
      { id: "up", title: "Upload", file: "src/lib/upload.ts", start: 1, end: 4, hot: [2], role: "r", why: claim("w"), say: claim("s") },
    ],
    edges: [{ from: "page", to: "up", label: "files", type: "" }],
    steps,
    example: null,
  };
}

describe("board tour", () => {
  it("keeps sound beats and turns unsound ones into plain talk", () => {
    const b = cleanBoard(spec([step({
      beats: [
        beat({ kind: "point", lines: [2, 99], values: [{ line: 3, text: " n = 3 ", other: "" }, { line: 3, text: "size = 3 MB", other: "" }, { line: 99, text: "off the card", other: "" }] }),
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
    expect(beats[0]!.values).toEqual([{ line: 3, text: "n = 3", other: "" }]);
    expect(beats[2]!.tone).toBe("curious");
    expect(beats[3]).toMatchObject({ text: "Because.", lines: [3] });
    expect(b.version).toBe(5);
  });

  it("labels every point: the writer's claim, or a guess resting on the marked lines", () => {
    const b = cleanBoard(spec([step({
      beats: [
        beat({ kind: "point", text: "It doubles n.", lines: [4], claim: { ...claim("helper doubles n"), evidence: [{ file: "src/lib/upload.ts", start: 3, end: 4, mentions: ["n * 2"] }] } }),
        beat({ kind: "point", text: "Then it returns.", lines: [4] }),
        beat({ kind: "say", text: "Like a photocopier.", analogy: true }),
        beat({ kind: "ask", text: "Why?", analogy: true }),
      ],
    })]), facts, root, "f", "m");
    const [own, guess, picture, ask] = b.steps[0]!.beats;
    expect(own!.claim).toMatchObject({ text: "helper doubles n", label: "confirmed" });
    expect(guess!.claim).toMatchObject({ text: "Then it returns.", label: "inferred", evidence: [{ file: "src/lib/upload.ts", start: 4, end: 4 }] });
    expect(picture).toMatchObject({ kind: "say", analogy: true, claim: null });
    expect(ask!.analogy).toBe(false);
  });

  it("builds up the example's state from the intro through the flow, marking what's new or changed", () => {
    const held = (key: string, value: string) => ({ key, value });
    const b = cleanBoard(spec([
      step({ part: "intro", card: "", state: [held("file", "a.jpg")] }),
      step({ part: "flow", state: [held("file", "a.jpg"), held("status", "sent")] }),
      step({ part: "flow", state: [held("file", "a.jpg"), held("status", "saved")] }),
      step({ part: "fail", hops: [{ edge: "page>up", back: false, stat: "500", tone: "bad" }], state: [held("status", "500")] }),
    ]), facts, root, "f", "m");
    expect(b.steps.map((s) => s.state.map((h) => `${h.key}:${h.change}`))).toEqual([["file:new"], ["file:same", "status:new"], ["file:same", "status:changed"], []]);
  });

  it("keeps a value beside a line only when the line names it", () => {
    expect(valueFits("file.size = 3 MB → passes", "if (file.size > MAX) throw")).toBe(true);
    expect(valueFits("attempt = 2", "const n = retries + 1;")).toBe(false);
    expect(valueFits("→ passes", "anything")).toBe(true);
    expect(valueFits("status 403 → expired", "if (res.status === 403)")).toBe(true);
    expect(valueFits("a == b", "x")).toBe(true);
    // Found on a real board: names inside longer identifiers, other spellings, or the value itself on the line.
    expect(valueFits('status = "starting"', 'setStatus("starting");')).toBe(true);
    expect(valueFits("artifactType = SELFIE", "artifact_type: type,")).toBe(true);
    expect(valueFits("file = selfie.jpg, image/jpeg", 'return new File([blob], "selfie.jpg", { type });')).toBe(true);
    expect(valueFits('error = "upload"', 'setError("upload");')).toBe(true);
  });

  it("keeps a recap's whole route, a change's touched cards, exact underlines and the other way through", () => {
    const b = cleanBoard(spec([
      step({ part: "recap", card: "up", route: ["page>up", "up>nowhere"] }),
      step({ part: "change", touches: ["page", "up", "ghost"], beats: [beat({
        kind: "point", lines: [4],
        values: [{ line: 4, text: "→ 6", other: "n = 0 → 0" }],
        focus: [{ line: 4, text: "n * 2", cue: "doubles" }, { line: 4, text: "n * 3", cue: "" }],
      })] }),
      step({ part: "change", card: "" }),
    ]), facts, root, "f", "m");
    expect(b.steps[0]).toMatchObject({ part: "recap", card: "", route: ["page>up"] });
    expect(b.steps[1]).toMatchObject({ part: "change", card: "up", touches: ["page"] });
    const point = b.steps[1]!.beats[0]!;
    expect(point.values).toEqual([{ line: 4, text: "→ 6", other: "n = 0 → 0" }]);
    expect(point.focus).toEqual([{ line: 4, text: "n * 2", cue: "doubles" }]);
    expect(b.steps[2]!.part).toBe("close");
  });

  it("finds the tests that reach the flow's files", () => {
    expect(flowTests(facts, ["src/lib/upload.ts"])).toEqual(["src/lib/upload.test.ts"]);
    expect(flowTests(facts, ["src/ui/Page.tsx"])).toEqual([]);
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
    expect(b.version).toBe(5);
    expect(b.example).toBeNull();
    expect(b.steps.every((s) => s.state.length === 0 && s.beats.every((x) => x.analogy === false))).toBe(true);
    expect(b.steps.map((s) => s.part)).toEqual(["intro", "flow", "fail", "why", "close"]);
    expect(b.steps[1]!.beats.map((x) => [x.kind, x.lines])).toEqual([["ask", []], ["reveal", [81]]]);
    expect(b.steps[2]).toMatchObject({ card: "up", beats: [{ kind: "say", text: "Here's one that goes wrong: Storage refuses." }, { kind: "reveal", text: "It fails." }] });
    expect(b.steps[3]!.beats.map((x) => x.text)).toEqual(["Why one retry?", "To bound it.", "Without it: Loops forever."]);
    expect(b.steps[4]!.beats[0]!.text).toBe("Now you can say it.");
    expect("tryIt" in b || "defend" in b).toBe(false);
  });
});
