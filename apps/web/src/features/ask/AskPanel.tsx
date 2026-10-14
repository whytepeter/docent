import { useEffect, useRef, useState } from "react";
import type { AskAnswer, Route } from "@docent/contracts";
import { headerStore } from "../../shared/state/header.ts";
import { sceneStore, stopScene } from "../../shared/state/scene.ts";
import { useStore } from "../../shared/state/store.ts";
import { Icon, shortPath } from "../../shared/ui/index.ts";
import { openCode } from "../code/index.ts";
import { askQuestion, isAsking, routeKey, stopAsking, useThread, type Turn } from "./thread.ts";
import "./ask.css";

const STEP_MS = 3600;
const LABEL: Record<string, string> = {
  confirmed: "Confirmed · read in the code, citation checked, and a second reader couldn't refute it",
  inferred: "Inferred · a reasoned guess",
  unknown: "Unknown · can't be established from this repo",
  record: "Record · from commit history",
};
const STAGE: Record<string, string> = { reading: "Reading the view", answering: "Reading the code", checking: "Checking every claim" };
const SIMPLER = "Explain that again more simply: start with an everyday analogy, then the same steps in plain words.";

/** Plays an answer's scene on the canvas, one step at a time, then stops. */
function play(answer: AskAnswer) {
  if (answer.scene.length) sceneStore.set({ steps: answer.scene, index: 0 });
}

function Answer({ turn, route, latest }: { turn: Turn; route: Route; latest: boolean }) {
  if (turn.stage === "error") return <p className="ask-error">{turn.error}</p>;
  if (!turn.answer) {
    return (
      <div className="ask-wait" role="status">
        <span className="spinner" aria-hidden="true" />{STAGE[turn.stage] ?? "Working"}…
        <button className="link" onClick={stopAsking}>Stop</button>
      </div>
    );
  }
  const a = turn.answer;
  return (
    <div className="ask-answer">
      {a.paragraphs.map((p, i) => (
        <div key={i} className="ask-para">
          <span className={`dot ${p.label}`} title={p.review?.verdict === "upheld" ? `${LABEL[p.label]}: ${p.review.reason}` : LABEL[p.label]} />
          <div>
            <p>{p.text}</p>
            {(p.evidence.length > 0 || (p.label === "record" && p.commit)) && (
              <div className="evidence">
                {p.evidence.map((e, j) => (
                  <button key={j} className={`ev-chip${e.check.ok ? "" : " bad"}`} title={e.check.ok ? `${e.file}:${e.start}–${e.end}` : e.check.reason} onClick={() => openCode(e.file, e.start, e.end)}>
                    {shortPath(e.file, 1)}:{e.start}{e.end !== e.start ? `–${e.end}` : ""}
                  </button>
                ))}
                {p.label === "record" && p.commit && <span className="ev-chip static">commit {p.commit.slice(0, 7)}</span>}
              </div>
            )}
            {p.checkNote && <p className="check-note">Docent first said “{p.claimedLabel}”; {p.checkNote}.</p>}
          </div>
        </div>
      ))}
      <div className="ask-actions">
        {a.scene.length > 0 && <button className="ask-chip primary" onClick={() => play(a)}><Icon name="play" size={13} weight="bold" />Show me</button>}
        {latest && <button className="ask-chip" disabled={isAsking()} onClick={() => void askQuestion(route, SIMPLER)}>Explain simpler</button>}
      </div>
    </div>
  );
}

/** The scene's caption and controls, while it plays. Steps advance on their own. */
function SceneBar() {
  const scene = useStore(sceneStore);
  useEffect(() => {
    if (!scene) return;
    const t = setTimeout(() => sceneStore.set((s) => (s && s.index < s.steps.length - 1 ? { ...s, index: s.index + 1 } : s)), STEP_MS);
    return () => clearTimeout(t);
  }, [scene]);
  if (!scene) return null;
  const step = scene.steps[scene.index]!;
  const go = (d: number) => sceneStore.set((s) => s && { ...s, index: Math.max(0, Math.min(s.steps.length - 1, s.index + d)) });
  return (
    <div className="scene-bar" role="status" aria-live="polite">
      <span className="scene-n">{scene.index + 1}/{scene.steps.length}</span>
      <span className="grow">{step.caption}</span>
      <button className="tbtn" onClick={() => go(-1)} disabled={scene.index === 0} aria-label="Previous step"><span className="flip"><Icon name="chevron" size={14} /></span></button>
      <button className="tbtn" onClick={() => go(1)} disabled={scene.index === scene.steps.length - 1} aria-label="Next step"><Icon name="chevron" size={14} /></button>
      <button className="tbtn" onClick={stopScene} aria-label="Stop"><Icon name="stop" size={14} /></button>
    </div>
  );
}

/**
 * Ask Docent: a conversation about what's on screen. Answers come back checked (every claim labeled,
 * citations verified, a second reader trying to refute them) and can be shown on the canvas.
 */
export function AskPanel({ route, onClose }: { route: Route; onClose: () => void }) {
  const key = routeKey(route);
  const turns = useThread(key);
  const header = useStore(headerStore);
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const busy = isAsking();
  // While a scene plays, the panel shrinks to its caption so the canvas can be seen.
  const playing = !!useStore(sceneStore);

  // Braces matter: scrollTo returns a promise in current browsers, and an effect may only return a cleanup.
  useEffect(() => {
    input.current?.focus();
  }, [key]);
  useEffect(() => {
    void list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [turns.length, turns.at(-1)?.stage]);
  // A scene belongs to the view it was asked in.
  useEffect(() => () => stopScene(), [key]);
  useEffect(() => () => stopScene(), []);

  const send = () => {
    const q = text.trim();
    if (!q || busy) return;
    setText("");
    void askQuestion(route, q);
  };

  return (
    <section className={`float ask${playing ? " playing" : ""}`} aria-label="Ask Docent">
      <SceneBar />
      {!playing && <>
      <div className="ask-head">
        <Icon name="ask" size={16} />
        <span className="grow">Ask about <b>{header.title || "this view"}</b></span>
        <button className="tbtn" onClick={onClose} aria-label="Close ( / )" title="Close ( / )"><Icon name="close" size={15} /></button>
      </div>
      {turns.length > 0 && (
        <div className="ask-thread" ref={list}>
          {turns.map((t, i) => (
            <div key={i} className="ask-turn">
              <p className="ask-q">{t.question}</p>
              <Answer turn={t} route={route} latest={i === turns.length - 1} />
            </div>
          ))}
        </div>
      )}
      <form className="ask-input" onSubmit={(e) => (e.preventDefault(), send())}>
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={turns.length ? "Ask a follow-up" : "What happens if the upload fails? Why does this exist?"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), send());
            if (e.key === "Escape") onClose();
          }}
          aria-label="Your question"
        />
        <button className="ask-send" type="submit" disabled={!text.trim() || busy} aria-label="Ask"><Icon name="send" size={15} weight="bold" /></button>
      </form>
      </>}
    </section>
  );
}
