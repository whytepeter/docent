import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Facts } from "@docent/extract";
import { redact } from "@docent/llm";
import { citeBoard, claimCards, claimsOf, type Board } from "./board.ts";

/*
 * Is a board still true to the code? Each card's excerpt is looked for in its file as it is now: where it was
 * (same), somewhere else (moved), or nowhere (changed), or the file is gone. Code that only moved is fixed
 * mechanically, with no AI: the board's lines are shifted to match. Changed cards can be updated; a flow that
 * changed too much is drawn again.
 */

export type CardFreshness = "same" | "moved" | "changed" | "gone";

export interface Freshness {
  /**
   * fresh: nothing changed. moved: code only moved (refreshBoard fixes it). changed: some cards' code changed
   * (updateBoard rewrites those). redraw: a card's file is gone or most cards changed, so the board is drawn again.
   */
  state: "fresh" | "moved" | "changed" | "redraw";
  cards: { id: string; title: string; state: CardFreshness; start?: number }[];
}

export function freshness(board: Board, facts: Facts, root: string): Freshness {
  const cards: Freshness["cards"] = board.cards.map((c) => {
    let all: string[];
    try {
      all = readFileSync(join(root, c.file), "utf8").split("\n").map((l) => redact(l));
    } catch {
      return { id: c.id, title: c.title, state: "gone" };
    }
    const at = (s: number) => c.lines.every((l, k) => all[s - 1 + k] === l);
    if (at(c.start)) return { id: c.id, title: c.title, state: "same" };
    const found: number[] = [];
    for (let s = 1; s + c.lines.length - 1 <= all.length && found.length < 2; s++) if (at(s)) found.push(s);
    // Found once is a move; twice is ambiguous, so it counts as changed rather than guessing.
    return found.length === 1 ? { id: c.id, title: c.title, state: "moved", start: found[0] } : { id: c.id, title: c.title, state: "changed" };
  });
  // A citation that held when the board was drawn and fails now (after the moves) means its card's code changed,
  // even when the excerpt itself didn't.
  const before = claimsOf(board);
  const after = claimsOf(citeBoard(refreshBoard(board, { state: "moved", cards }, facts, root), facts, root));
  const owners = claimCards(board);
  before.forEach((c, i) => {
    const held = c.evidence.length && c.evidence.every((e) => e.check.ok);
    const fails = after[i]?.evidence.some((e) => !e.check.ok);
    const card = cards.find((x) => x.id === owners[i]);
    if (held && fails && card && card.state !== "gone") card.state = "changed";
  });
  const count = (s: CardFreshness) => cards.filter((c) => c.state === s).length;
  const state = count("gone") || count("changed") * 2 > cards.length ? "redraw" : count("changed") ? "changed" : count("moved") ? "moved" : "fresh";
  return { state, cards };
}

/**
 * Shifts everything on the board that points into a moved excerpt (the card, its marks, values, underlines and
 * the claims citing those lines) to where the code is now, then runs the citation check again. The words stay
 * exactly as they were.
 */
export function refreshBoard(board: Board, fresh: Freshness, facts: Facts, root: string): Board {
  const moves = new Map(fresh.cards.filter((c) => c.state === "moved" && c.start).map((c) => [c.id, c.start!]));
  if (!moves.size) return board;
  const ranges = board.cards.flatMap((c) => (moves.has(c.id) ? [{ file: c.file, from: c.start, to: c.start + c.lines.length - 1, by: moves.get(c.id)! - c.start }] : []));
  const shift = (file: string, n: number) => n + (ranges.find((r) => r.file === file && n >= r.from && n <= r.to)?.by ?? 0);
  const fileOf = new Map(board.cards.map((c) => [c.id, c.file]));
  const moveClaim = <T extends { evidence: { file: string; start: number; end: number }[] }>(c: T): T => ({
    ...c,
    evidence: c.evidence.map((e) => {
      const by = ranges.find((r) => r.file === e.file && e.start >= r.from && e.end <= r.to)?.by ?? 0;
      return { ...e, start: e.start + by, end: e.end + by };
    }),
  });
  const moved: Board = {
    ...board,
    cards: board.cards.map((c) => (moves.has(c.id) ? { ...c, start: moves.get(c.id)!, hot: c.hot.map((h) => shift(c.file, h)), why: moveClaim(c.why), say: moveClaim(c.say) } : { ...c, why: moveClaim(c.why), say: moveClaim(c.say) })),
    steps: board.steps.map((s) => {
      const file = fileOf.get(s.card) ?? "";
      return {
        ...s,
        beats: s.beats.map((b) => ({
          ...b,
          lines: b.lines.map((n) => shift(file, n)),
          values: b.values.map((v) => ({ ...v, line: shift(file, v.line) })),
          focus: b.focus.map((f) => ({ ...f, line: shift(file, f.line) })),
          claim: b.claim ? moveClaim(b.claim) : null,
        })),
      };
    }),
    example: board.example ? moveClaim(board.example) : null,
    refreshedAt: new Date().toISOString(),
  };
  return citeBoard(moved, facts, root);
}
