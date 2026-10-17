import { useSyncExternalStore } from "react";
import type { AskAnswer, AskedBefore, Route } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";

export type Stage = "reading" | "answering" | "checking";
export interface Turn {
  question: string;
  stage: Stage | "done" | "error";
  answer?: AskAnswer;
  error?: string;
  /** Answered before for the same board and code, and served from disk. */
  cachedAt?: string;
  /** Brought back from disk when the chat opened: shown as it was, not typed again. */
  restored?: boolean;
}

/** One conversation per view, kept while the app is open, so coming back to a view keeps its thread. */
const threads = new Map<string, Turn[]>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let version = 0;
const bump = () => ((version += 1), emit());
let inFlight: AbortController | null = null;

/** A board keeps one conversation whatever step it was asked from. */
export const routeKey = (route: Route) => JSON.stringify(route.view === "board" ? { view: "board", id: route.id } : route);

export function useThread(key: string): Turn[] {
  useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => version);
  return threads.get(key) ?? [];
}

export const isAsking = () => !!inFlight;

/** A board's earlier conversation, from disk, for a thread that has nothing in it yet. */
export function restoreThread(key: string, asked: AskedBefore[]): boolean {
  if (threads.get(key)?.length || !asked.length) return false;
  threads.set(key, asked.map((a) => ({ question: a.question, stage: "done", answer: a.answer, restored: true })));
  bump();
  return true;
}

/** `view` is what's on screen: the board's cards and links. */
export async function askQuestion(route: Route, question: string, view: { boxes: { id: string; title: string; sub?: string }[]; links: { from: string; to: string; label?: string }[] }): Promise<void> {
  const key = routeKey(route);
  const turns = threads.get(key) ?? [];
  const history = turns.filter((t) => t.answer).map((t) => ({ question: t.question, answer: t.answer!.paragraphs.map((p) => p.text).join(" ") }));
  const turn: Turn = { question, stage: "reading" };
  threads.set(key, [...turns, turn]);
  bump();
  inFlight?.abort();
  const abort = (inFlight = new AbortController());
  const { boxes, links } = view;
  try {
    await api.ask({ route, question, boxes, links, history }, (e) => {
      if (e.type === "stage") turn.stage = e.stage;
      // The draft is readable at once; its labels say "checking" until the final answer settles them.
      else if (e.type === "draft") turn.answer = e.answer;
      else if (e.type === "answer") Object.assign(turn, { stage: "done", answer: e.answer, ...(e.cachedAt ? { cachedAt: e.cachedAt } : {}) });
      else Object.assign(turn, { stage: "error", error: e.error });
      bump();
    }, abort.signal);
    if (turn.stage !== "done" && turn.stage !== "error") Object.assign(turn, { stage: "error", error: "The answer stopped before it finished." });
  } catch (e) {
    Object.assign(turn, abort.signal.aborted ? { stage: "error", error: "Stopped." } : { stage: "error", error: (e as Error).message });
  } finally {
    if (inFlight === abort) inFlight = null;
    bump();
  }
}

export function stopAsking(): void {
  inFlight?.abort();
}
