import { useEffect, useRef, useState } from "react";
import type { Board, BoardState } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { nextRate, rateStore, voiceOnStore } from "../../shared/state/playback.ts";
import { useStore } from "../../shared/state/store.ts";
import { editorThemeStore, openCode, toHtml } from "../code/index.ts";
import { timeLeft, useNow, useProgress } from "../jobs/index.ts";
import { Icon, ThemeButton } from "../../shared/ui/index.ts";
import { Chat } from "./Chat.tsx";
import { loadProgress, saveProgress } from "./progress.ts";
import { Said } from "./Said.tsx";
import { BoardEngine, type EngineState, type Saved } from "./engine.ts";
import "./board.css";

/** What each part of the tour is, for the step dots. */
const PART: Record<Board["steps"][number]["part"], string> = {
  intro: "The big picture", flow: "Following the request", fail: "When it goes wrong", why: "Why it's built this way", close: "Now you can say it",
};

const savedKey = (id: string, b: Board) => `docent:board:${id}:${b.generatedAt}`;
function loadSaved(id: string, b: Board): Saved {
  try {
    return JSON.parse(localStorage.getItem(savedKey(id, b)) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

/** Highlighted HTML per line, from the app's code highlighter. */
async function highlight(lines: string[], file: string, start: number): Promise<string[]> {
  const html = await toHtml(lines, file, start, null);
  const box = document.createElement("div");
  box.innerHTML = html;
  return [...box.querySelectorAll(".line")].map((l) => l.innerHTML);
}

/** A flow's whiteboard: drawn on demand (a few minutes), then one guided tour of it, with Ask beside it. */
export function BoardScreen({ id, repoName, onHome, onSettings }: { id: string; repoName: string; onHome: () => void; onSettings: () => void }) {
  const [state, setState] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await api.board(id);
        if (!live) return;
        setState(s);
        // Nothing drawn yet and nothing drawing: start it, no button needed.
        if (!s.board && (!s.job || s.job.finishedAt) && !started.current) {
          started.current = true;
          await api.writeBoard(id);
        }
        const running = !!s.job && !s.job.finishedAt;
        if (running || !s.board) t = setTimeout(() => void tick(), 2000);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [id]);

  if (error) return <div className="bd-msg">{error} <button className="bd-link" onClick={onHome}>Back to the flows</button></div>;
  if (!state) return <div className="bd-msg"><span className="spinner" /> Opening the board…</div>;
  if (!state.board) return <Drawing state={state} onHome={onHome} />;
  return <BoardView id={id} board={state.board} job={state.job} repoName={repoName} onHome={onHome} onSettings={onSettings} />;
}

/** While a board is drawn: what's happening, how long is left, and the flow's outline to read meanwhile. */
function Drawing({ state, onHome }: { state: BoardState; onHome: () => void }) {
  const job = state.job && !state.job.finishedAt ? state.job : null;
  const now = useNow(!!job);
  const progress = useProgress(job, now);
  const failed = state.job?.finishedAt && state.job.error;
  return (
    <div className="bd-stage bd-static">
      <div className="bd-wait">
        <div className="bd-wait-kick">Drawing the board</div>
        <h2>{state.flow.title}</h2>
        <div className="bd-wait-status">
          {failed ? null : <span className="spinner" aria-hidden="true" />}
          <span>{failed ? `Couldn't draw it: ${state.job?.error}` : job?.stage ?? "Starting"}</span>
          {job && <span className="bd-wait-left">{timeLeft(job, now)}</span>}
        </div>
        {!failed && <div className="bd-wait-bar"><i style={{ transform: `scaleX(${job ? progress : 0.03})` }} /></div>}
        {failed && <button className="bd-btn pri" onClick={() => void api.writeBoard(state.flow.id)}>Try again</button>}
        <div className="bd-sticky-static">
          <p>{state.flow.summary}</p>
          <p className="bd-wait-files">It runs through {state.flow.files.map((f) => f.split("/").pop()).join(" → ")}</p>
        </div>
        <button className="bd-link" onClick={onHome}>← Other flows</button>
      </div>
    </div>
  );
}


function BoardView({ id, board, job, repoName, onHome, onSettings }: { id: string; board: Board; job: BoardState["job"]; repoName: string; onHome: () => void; onSettings: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const capT = useRef<HTMLElement>(null);
  const capP = useRef<HTMLParagraphElement>(null);
  const engine = useRef<BoardEngine | null>(null);
  const [es, setEs] = useState<EngineState | null>(null);
  const rate = useStore(rateStore);
  const voiceOn = useStore(voiceOnStore);
  const { data: voice } = useQuery("voice-status", api.voice);
  const speak = voiceOn && !!voice?.available;
  const [chat, setChat] = useState(false);
  // A "Why?" from the tour: the question it asked, and whether the tour was playing when it was asked.
  const [why, setWhy] = useState<{ q: string; was: boolean } | null>(null);
  const live = useRef({ rate, speak, chat });
  live.current = { rate, speak, chat };

  useEffect(() => {
    if (!stage.current || !capT.current || !capP.current) return;
    const narrow = () => (stage.current?.clientWidth ?? 1000) < 700;
    const e = new BoardEngine(stage.current, board, {
      caption: { title: capT.current, text: capP.current },
      onState: setEs,
      rate: () => live.current.rate,
      voice: (at, beat) => (live.current.speak ? api.boardVoice(id, at, beat).catch(() => null) : Promise.resolve(null)),
      highlight,
      openCode,
      // The story bar covers the bottom; frame the board in the space above it.
      insets: () => {
        const nar = narrow();
        const bar = document.querySelector<HTMLElement>(".bd-bar")?.offsetHeight ?? 120;
        // The open chat takes the right side; frame the board in what's left.
        return { t: 70, b: bar + 32, l: nar ? 16 : 40, r: nar ? 16 : live.current.chat ? 440 : 40 };
      },
      saved: loadSaved(id, board),
      // Pick up where you stopped, unless you'd finished (then it starts over) or the board was drawn again.
      startAt: (() => {
        const p = loadProgress(repoName, id);
        return p && p.generatedAt === board.generatedAt && !p.done ? p.step : 0;
      })(),
      persist: (s) => {
        try {
          localStorage.setItem(savedKey(id, board), JSON.stringify(s));
        } catch {
          /* storage off */
        }
      },
    });
    engine.current = e;
    return () => {
      e.destroy();
      engine.current = null;
    };
    // The engine is built once per written board; later label updates go through refresh().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, board.generatedAt]);
  useEffect(() => {
    engine.current?.refresh(board);
  }, [board]);
  // A new editor theme recolours the code on the cards in place.
  useEffect(() => {
    const off = editorThemeStore.subscribe(() => engine.current?.rehighlight());
    return () => void off();
  }, []);
  // Remember how far the tour got; reaching the last step counts as watched.
  const at = es?.step;
  useEffect(() => {
    if (at === undefined) return;
    const last = board.steps.length - 1;
    const before = loadProgress(repoName, id);
    const done = at === last || (before?.generatedAt === board.generatedAt && before.done);
    saveProgress(repoName, id, { generatedAt: board.generatedAt, step: at, steps: board.steps.length, done });
  }, [at, repoName, id, board.generatedAt, board.steps.length]);
  // Where the story bar would cover the corner, the zoom controls sit just above it.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = root.current?.querySelector<HTMLElement>(".bd-bar");
    if (!bar || !root.current) return;
    // On <html>, so the background tray (outside the board) can sit above the bar too.
    const r = document.documentElement;
    const ro = new ResizeObserver(() => r.style.setProperty("--bar-h", `${bar.offsetHeight}px`));
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // "/" opens the chat, as in most apps with a search or ask box.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target instanceof Element ? ev.target : null;
      if (ev.key === "/" && !ev.metaKey && !ev.ctrlKey && !t?.closest("input, textarea, [contenteditable]")) (ev.preventDefault(), setChat(true));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const closeChat = () => {
    setChat(false);
    engine.current?.unpoint();
    if (why) engine.current?.resume(why.was);
    setWhy(null);
  };
  /** Why? on what Docent just said: the tour holds, and the chat asks about that sentence. */
  const askWhy = () => {
    const said = capP.current?.textContent?.trim();
    const eng = engine.current;
    if (!said || !eng) return;
    const was = why ? why.was : eng.hold();
    setWhy({ q: `Why is that? You just said: “${said}”`, was });
    setChat(true);
  };

  const e = engine.current;
  // A reveal shows what it rests on: its label and lines, under the caption.
  const said = es?.beat ? board.steps[es.step]?.beats[es.beat.i] : null;
  const paused = !!e?.isPaused();
  const checking = board.status === "checking" && !!job && !job.finishedAt;
  return (
    <div className="bd-root" ref={root}>
      <div className="bd-stage" ref={stage} />
      <div className="bd-fl bd-brand">
        <button className="bd-back" onClick={onHome} title="All flows" aria-label="All flows"><Icon name="back" size={18} /></button>
        <span className="bd-brand-t"><b>{board.title}</b><small>{repoName}</small></span>
        {checking && <span className="bd-checking" title="A second reader is checking every claim against the code; the dots on the notes update when it's done">double-checking</span>}
      </div>
      <ThemeButton className="bd-fl bd-gear bd-theme" />
      <button className="bd-fl bd-gear" onClick={onSettings} aria-label="Settings" title="Settings: voice, Claude"><Icon name="settings" size={18} /></button>
      {/* Out of the way, as in FigJam: zoom in, zoom out, and reset to the whole board. */}
      <div className="bd-zoomp" role="group" aria-label={`Zoom, now ${Math.round((es?.zoom ?? 0.5) * 100)}%`}>
        <button onClick={() => e?.zoom(1.25)} aria-label="Zoom in" title="Zoom in"><Icon name="plus" size={14} /></button>
        <button onClick={() => e?.zoom(0.8)} aria-label="Zoom out" title="Zoom out"><Icon name="minus" size={14} /></button>
        <button onClick={() => void e?.fit()} aria-label="Reset: fit the board (F)" title="Reset: fit the board (F)"><Icon name="fit" size={13} /></button>
      </div>

      {chat && es && e && <Chat board={board} es={es} engine={e} onClose={closeChat} ask={why?.q} backToTour={!!why} />}
      {/* The story bar: one place for what's being said, where you are, and what you can do next. */}
      <div className="bd-fl bd-bar">
        <div className="bd-bar-body" aria-live="polite">
          <div className="bd-cap">
            <div className="bd-cap-head">
              <small ref={capT} />
              <button className="bd-why" onClick={askWhy} title="Ask why about what Docent just said; the tour waits">Why?</button>
            </div>
            <p ref={capP} />
          </div>
          {said?.kind === "reveal" && said.claim && <Said claim={said.claim} checking={checking} className="bare" />}
        </div>
        <div className="bd-bar-ctl">
          <button onClick={() => e?.goStep((es?.step ?? 0) - 1)} aria-label="Previous step (←)" title="Previous step (←)"><Icon name="prev" size={16} fill /></button>
          <button className="bd-play" onClick={() => e?.play()} aria-label={!es?.playing || paused ? "Play (space)" : "Pause (space)"}>{!es?.playing || paused ? <Icon name="play" size={15} fill /> : <Icon name="pause" size={15} fill />}{!es?.playing ? "Play" : paused ? "Resume" : "Pause"}</button>
          <button onClick={() => e?.goStep((es?.step ?? 0) + 1)} aria-label="Next step (→)" title="Next step (→)"><Icon name="next" size={16} fill /></button>
          <div className="bd-steps">
            {board.steps.map((st, i) => (
              <b key={i} role="button" aria-label={`Step ${i + 1}: ${PART[st.part]}`} title={PART[st.part]} className={`${i === es?.step ? "on" : i < (es?.step ?? 0) ? "done" : ""}${i > 0 && board.steps[i - 1]!.part !== st.part ? " gap" : ""}`} onClick={() => e?.goStep(i)} />
            ))}
          </div>
          <span className="bd-bar-gap" />
          <button onClick={() => rateStore.set(nextRate(rate))} title="Speed">{rate}×</button>
          <button
            onClick={() => voiceOnStore.set(!voiceOn)}
            disabled={!voice?.available}
            aria-pressed={speak}
            title={!voice ? "" : voice.available ? (voiceOn ? "Mute the narrator" : "Hear the narrator") : voice.reason}
          ><Icon name={speak ? "sound" : "muted"} size={18} /></button>
          <button className={`bd-ask${chat ? " on" : ""}`} onClick={() => (chat ? closeChat() : setChat(true))} aria-pressed={chat} aria-label="Ask Docent" title="Ask Docent about this board (/)">
            <Icon name="ask" size={16} /><span className="bd-ask-t">Ask</span>
          </button>
        </div>
      </div>
    </div>
  );
}
