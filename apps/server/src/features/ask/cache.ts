import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBoard } from "@docent/analyze";
import type { AskAnswer, AskedBefore } from "@docent/contracts";
import { repoCacheDir, type Facts } from "@docent/extract";

/*
 * Answers kept on disk, per board, in Docent's own folder (never the repo). An answer counts only for the
 * board as it was drawn and the code as it was at the time: a redrawn board or a new commit asks afresh.
 * The same file brings a board's conversation back after a reload.
 */

interface Entry extends AskedBefore {
  key: string;
  boardAt: string;
  head: string | null;
}

const MAX = 60;
const dir = (root: string) => {
  const d = join(repoCacheDir(root), "answers");
  mkdirSync(d, { recursive: true });
  return d;
};
const file = (root: string, boardId: string) => join(dir(root), `${boardId.replace(/[^a-z0-9-]/gi, "_")}.json`);

function read(root: string, boardId: string): Entry[] {
  try {
    return JSON.parse(readFileSync(file(root, boardId), "utf8")) as Entry[];
  } catch {
    return [];
  }
}

/** The same question about the same card: case, spacing and a trailing "?" don't matter. */
const keyOf = (question: string, card: string) => `${card}::${question.toLowerCase().replace(/\s+/g, " ").replace(/[?\s]+$/, "").trim()}`;

/** What an answer is tied to: the board as drawn and the commit the code was at. */
function stamp(root: string, facts: Facts, boardId: string) {
  const board = loadBoard(root, boardId);
  return board ? { boardAt: board.generatedAt, head: facts.repo.head, board } : null;
}

const cardOf = (board: NonNullable<ReturnType<typeof loadBoard>>, step?: number, card?: string) => card ?? (step !== undefined ? board.steps[step]?.card : "") ?? "";

/** An answer to this question about this card, if one was given for the board and code as they are now. */
export function cachedAnswer(root: string, facts: Facts, boardId: string, question: string, step?: number, card?: string): Entry | null {
  const s = stamp(root, facts, boardId);
  if (!s) return null;
  const key = keyOf(question, cardOf(s.board, step, card));
  return read(root, boardId).find((e) => e.key === key && e.boardAt === s.boardAt && e.head === s.head) ?? null;
}

export function saveAnswer(root: string, facts: Facts, boardId: string, question: string, answer: AskAnswer, step?: number, card?: string): void {
  const s = stamp(root, facts, boardId);
  if (!s) return;
  const key = keyOf(question, cardOf(s.board, step, card));
  const entry: Entry = { key, question, answer, at: new Date().toISOString(), boardAt: s.boardAt, head: s.head };
  const rest = read(root, boardId).filter((e) => e.key !== key);
  writeFileSync(file(root, boardId), JSON.stringify([...rest, entry].slice(-MAX), null, 2));
}

/** The board's conversation so far, oldest first, for the board and code as they are now. */
export function askedBefore(root: string, facts: Facts, boardId: string): AskedBefore[] {
  const s = stamp(root, facts, boardId);
  if (!s) return [];
  return read(root, boardId)
    .filter((e) => e.boardAt === s.boardAt && e.head === s.head)
    .map(({ question, answer, at }) => ({ question, answer, at }));
}
