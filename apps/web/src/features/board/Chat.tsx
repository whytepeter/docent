import { useEffect, useRef, useState } from "react";
import type { Board, Route } from "@docent/contracts";
import { Icon } from "../../shared/ui/index.ts";
import { askQuestion, routeKey, stopAsking, useThread, type Turn } from "../ask/index.ts";
import type { BoardEngine, EngineState } from "./engine.ts";
import { Said } from "./Said.tsx";

const STAGE: Record<string, string> = { reading: "Reading the board", answering: "Reading the code", checking: "Checking every claim" };

/** What an answer cites, for the board to point at. */
function pointOf(turn: Turn) {
  const a = turn.answer;
  if (!a) return null;
  return { cards: [...new Set(a.scene.flatMap((s) => s.nodes))], evidence: a.paragraphs.flatMap((p) => p.evidence.filter((e) => e.check.ok)) };
}

/**
 * Ask Docent, on the board: a question about what you're looking at, answered from the code. Every
 * sentence is checked like the board's own notes, and the board points at the lines the answer rests on.
 */
export function Chat({ board, es, engine, onClose }: { board: Board; es: EngineState; engine: BoardEngine; onClose: () => void }) {
  const step = es.mode === "tour" ? es.step : undefined;
  const card = step !== undefined ? board.steps[step]?.card || undefined : undefined;
  const route: Route = { view: "board", id: board.flowId, ...(step !== undefined ? { step } : {}), ...(card ? { card } : {}) };
  const turns = useThread(routeKey(route));
  const [q, setQ] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = turns.some((t) => t.stage !== "done" && t.stage !== "error");
  // Answers from before the chat opened aren't replayed; only new ones point.
  const pointed = useRef(turns.length);

  // The thread updates its turns in place, so watch the last turn's stage, not the array.
  const last = turns[turns.length - 1];
  const lastStage = last?.stage;
  // When an answer lands, the board shows where it lives.
  useEffect(() => {
    if (last?.stage === "done" && pointed.current !== turns.length) {
      pointed.current = turns.length;
      const p = pointOf(last);
      if (p) engine.pointAt(p.cards, p.evidence);
    }
  }, [lastStage, turns.length, last, engine]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [lastStage, turns.length]);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const send = (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setQ("");
    void askQuestion(route, question, {
      boxes: board.cards.map((c) => ({ id: c.id, title: c.title, sub: c.file })),
      links: board.edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
    });
  };
  const here = board.cards.find((c) => c.id === card);
  const ideas = [
    here ? `What does “${here.title}” do, step by step?` : "What's the riskiest part of this flow?",
    "Why is it built this way?",
    "What happens when this fails?",
  ];
  const checking = (t: Turn) => t.stage === "checking";

  return (
    <aside className="bd-chat" aria-label="Ask Docent">
      <header>
        <b>Ask Docent</b>
        <small>{here ? `About “${here.title}”` : board.title}</small>
        <button className="bd-chat-x" onClick={onClose} aria-label="Close the chat" title="Close"><Icon name="close" size={15} /></button>
      </header>
      <div className="bd-chat-list" ref={list}>
        {!turns.length && (
          <div className="bd-chat-empty">
            <p>Stuck on something? Ask in plain words. Docent answers from the code, checks every sentence, and points at the lines on the board.</p>
            {ideas.map((t) => (
              <button key={t} onClick={() => send(t)}>{t}</button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="bd-chat-turn">
            <p className="bd-chat-q">{t.question}</p>
            {t.stage === "error" ? (
              <p className="bd-chat-err">{t.error}</p>
            ) : t.answer ? (
              <div className="bd-chat-a">
                {t.answer.paragraphs.map((p, j) => <Said key={j} claim={p} checking={checking(t)} />)}
                {pointOf(t)?.evidence.length || pointOf(t)?.cards.length ? (
                  <button className="bd-chat-show" onClick={() => { const p = pointOf(t); if (p) engine.pointAt(p.cards, p.evidence); }}>
                    <Icon name="fit" size={13} />Show me on the board
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="bd-chat-wait" role="status"><span className="bd-chat-dots" aria-hidden="true"><i /><i /><i /></span>{STAGE[t.stage] ?? "Working"}…</p>
            )}
          </div>
        ))}
      </div>
      <form className="bd-chat-in" onSubmit={(e) => (e.preventDefault(), send(q))}>
        <textarea
          ref={input}
          rows={1}
          value={q}
          placeholder={here ? `Ask about ${here.title.toLowerCase()}…` : "Ask about this flow…"}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), send(q));
            if (e.key === "Escape") onClose();
          }}
          aria-label="Your question"
        />
        {busy ? (
          <button type="button" className="stop" onClick={stopAsking} aria-label="Stop" title="Stop"><Icon name="stop" size={13} fill /></button>
        ) : (
          <button type="submit" disabled={!q.trim()} aria-label="Send" title="Send (Enter)"><Icon name="send" size={15} weight="bold" /></button>
        )}
      </form>
    </aside>
  );
}
