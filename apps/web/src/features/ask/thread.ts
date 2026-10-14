import { useSyncExternalStore } from "react";
import type { AskAnswer, Route } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { canvasStore } from "../../shared/state/scene.ts";

export type Stage = "reading" | "answering" | "checking";
export interface Turn {
  question: string;
  stage: Stage | "done" | "error";
  answer?: AskAnswer;
  error?: string;
}

/** One conversation per view, kept while the app is open, so coming back to a view keeps its thread. */
const threads = new Map<string, Turn[]>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let version = 0;
const bump = () => ((version += 1), emit());
let inFlight: AbortController | null = null;

export const routeKey = (route: Route) => JSON.stringify(route);

export function useThread(key: string): Turn[] {
  useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => version);
  return threads.get(key) ?? [];
}

export const isAsking = () => !!inFlight;

export async function askQuestion(route: Route, question: string): Promise<void> {
  const key = routeKey(route);
  const turns = threads.get(key) ?? [];
  const history = turns.filter((t) => t.answer).map((t) => ({ question: t.question, answer: t.answer!.paragraphs.map((p) => p.text).join(" ") }));
  const turn: Turn = { question, stage: "reading" };
  threads.set(key, [...turns, turn]);
  bump();
  inFlight?.abort();
  const abort = (inFlight = new AbortController());
  const { boxes, links } = canvasStore.get();
  try {
    await api.ask({ route, question, boxes, links, history }, (e) => {
      if (e.type === "stage") turn.stage = e.stage;
      else if (e.type === "answer") Object.assign(turn, { stage: "done", answer: e.answer });
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
