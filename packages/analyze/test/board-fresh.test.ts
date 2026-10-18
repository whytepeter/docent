import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { extract, type Facts } from "@docent/extract";
import { citeBoard, cleanBoard, freshness, refreshBoard } from "../src/index.ts";

let facts: Facts;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "docent-fresh-"));
  cpSync(join(import.meta.dirname, "../../extract/test/fixture"), root, { recursive: true });
  facts = extract(root);
});

type Spec = Parameters<typeof cleanBoard>[0];
const ev = (file: string, start: number, end: number, ...mentions: string[]) => ({ file, start, end, mentions });
const claim = (text: string, ...evidence: ReturnType<typeof ev>[]) => ({ text, label: "confirmed" as const, evidence, commit: "", searched: "" });
const UP = "src/lib/upload.ts";

/** A small board: the page calls upload; the upload card shows lines 7–11 and a step points at line 9. */
function board() {
  const spec: Spec = {
    title: "t", intro: "i", pitch: "p", example: null,
    cards: [
      { id: "page", title: "Page", file: "src/ui/Page.tsx", start: 1, end: 5, hot: [], role: "r", why: claim("w"), say: claim("s") },
      { id: "up", title: "Upload", file: UP, start: 7, end: 11, hot: [9], role: "r", why: claim("w"), say: claim("It calls helper.", ev(UP, 9, 9, "helper(1)")) },
    ],
    edges: [{ from: "page", to: "up", label: "file", type: "src/lib/api.ts#Store" }],
    steps: [
      { part: "flow", card: "up", route: ["page>up"], touches: [], hops: [], state: [], beats: [
        { kind: "point", text: "It calls the helper.", tone: "calm", lines: [9], values: [{ line: 9, text: "→ returns 2", other: "" }], focus: [{ line: 9, text: "helper(1)", cue: "helper" }], claim: claim("upload calls helper(1)", ev(UP, 9, 9, "helper(1)")), analogy: false },
      ] },
    ],
  };
  return citeBoard(cleanBoard(spec, facts, root, "f", "m"), facts, root);
}
const edit = (f: string, change: (lines: string[]) => string[]) => writeFileSync(join(root, f), change(readFileSync(join(root, f), "utf8").split("\n")).join("\n"));

describe("keeping a board true to the code", () => {
  it("finds the declared shape of what travels along a link", () => {
    expect(board().edges[0]!.shape).toEqual({ name: "Store", file: "src/lib/api.ts", start: 1, end: 3 });
  });

  it("is fresh while the code is as it was drawn", () => {
    expect(freshness(board(), facts, root).state).toBe("fresh");
  });

  it("follows code that only moved, shifting every line on the board, with the words unchanged", () => {
    const b = board();
    edit(UP, (l) => ["// one", "// two", ...l]);
    const f = freshness(b, facts, root);
    expect(f.state).toBe("moved");
    expect(f.cards.find((c) => c.id === "up")).toMatchObject({ state: "moved", start: 9 });
    const r = refreshBoard(b, f, facts, root);
    const up = r.cards.find((c) => c.id === "up")!;
    const beat = r.steps[0]!.beats[0]!;
    expect([up.start, up.hot, beat.lines, beat.values[0]!.line, beat.focus[0]!.line]).toEqual([9, [11], [11], 11, 11]);
    expect(beat.claim).toMatchObject({ text: "upload calls helper(1)", label: "confirmed", evidence: [{ start: 11, end: 11, check: { ok: true } }] });
    expect(r.refreshedAt).toBeTruthy();
    expect(freshness(r, facts, root).state).toBe("fresh");
  });

  it("calls a card changed when its code changed, and the board one to redraw when a file is gone", () => {
    const b = board();
    edit(UP, (l) => l.map((x) => x.replace("helper(1)", "helper(2)")));
    const f = freshness(b, facts, root);
    expect(f.state).toBe("changed");
    expect(f.cards.map((c) => [c.id, c.state])).toEqual([["page", "same"], ["up", "changed"]]);
    rmSync(join(root, UP));
    expect(freshness(b, facts, root).state).toBe("redraw");
  });
});
