import { useEffect, useRef, useState } from "react";
import type { Board, BoardState } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { nextRate, rateStore, thinkStore, voiceOnStore } from "../../shared/state/playback.ts";
import { useStore } from "../../shared/state/store.ts";
import { editorThemeStore, openCode, toHtml } from "../code/index.ts";
import { timeLeft, useNow, useProgress } from "../jobs/index.ts";
import { Icon, ThemeButton } from "../../shared/ui/index.ts";
import { VoiceMenu } from "../settings/index.ts";
import { Chat } from "./Chat.tsx";
import { loadProgress, saveProgress } from "./progress.ts";
import { Said } from "./Said.tsx";
import { BoardEngine, type EngineState, type Saved } from "./engine.ts";
import "./board.css";

/** What each part of the tour is, for the step dots. */
const PART: Record<Board["steps"][number]["part"], string> = {
  intro: "The big picture", flow: "Following the request", recap: "The whole trip", fail: "When it goes wrong", why: "Why it's built this way",
  change: "If you change it", close: "Now you can say it",
};

/**
 * What the example holds so far, as one line in the story bar (never over the board): it builds up from the intro
 * through the flow (new and changed things flash), the recap and close keep the last of it, and it steps aside
 * while a failure, a reviewer's question or a change is told.
 */
function Holding({ board, at }: { board: Board; at: number }) {
  const st = board.steps[at];
  const last = [...board.steps].reverse().find((s) => s.state.length);
  const held = st?.part === "intro" || st?.part === "flow" ? st.state : st?.part === "close" || st?.part === "recap" ? last?.state.map((h) => ({ ...h, change: "same" as const })) ?? [] : [];
  if (!held.length) return null;
  return (
    <div className="bd-held" key={at} title="What the example request holds once this step has run: worked out from the example and the code, not from running it">
      <small>The example so far</small>
      {held.map((h) => (
        <span key={h.key} className={h.change}><i>{h.key}</i> {h.value}</span>
      ))}
    </div>
  );
}

/** The declared shape of what reaches this step's card, cut from the code itself: one click opens it. */
function Travels({ board, route }: { board: Board; route: string[] }) {
  const last = route[route.length - 1];
  const shape = board.edges.find((e) => `${e.from}>${e.to}` === last)?.shape;
  if (!shape) return null;
  return (
    <p className="bd-note bd-travels">
      What travels here is a <button className="bd-chip" title={`Open its declaration: ${shape.file}:${shape.start}–${shape.end}`} onClick={() => openCode(shape.file, shape.start, shape.end)}>{shape.name}</button>
    </p>
  );
}

/**
 * Keeping a board true to the code. Code that only moved was already fixed by the server, so nothing shows then.
 * Only when cards' code really changed does a note say which, offering to update just those cards (or to draw
 * the board again when too much changed); "Later" folds it to a button in the corner. The board on screen stays
 * until the new one lands.
 */
function Rewrite({ job, fresh, onRewrite }: { job: BoardState["job"]; fresh: BoardState["fresh"]; onRewrite: (mode: "draw" | "update") => Promise<void> }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const running = !!job && !job.finishedAt;
  const stale = fresh?.state === "changed" || fresh?.state === "redraw";
  if (!stale || running) return null;
  const changed = fresh.cards.filter((c) => c.state === "changed" || c.state === "gone");
  const go = (mode: "draw" | "update") => {
    setBusy(true);
    void onRewrite(mode).finally(() => setBusy(false));
  };
  const names = changed.map((c) => c.title).join(", ");
  const n = changed.length;
  return (
    <>
      <button className={`bd-fl bd-gear bd-redraw${open ? " on" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="The code changed since this board was drawn: update or redraw it" title="The code changed since this board was drawn: update or redraw it">
        <Icon name="warn" size={15} /><span>Code changed</span>
      </button>
      {open && (
        <div className="bd-fl bd-stale" role="status">
          <p>
            <b>The code changed since this board was drawn.</b>{" "}
            {fresh.state === "redraw" ? `Too much moved on to update it card by card (${names}), so it's best drawn again.` : `${n === 1 ? "This card" : "These cards"} no longer match: ${names}. Updating rewrites only ${n === 1 ? "it" : "them"} and what depends on ${n === 1 ? "it" : "them"}; the rest of the tour stays word for word.`}
          </p>
          <div>
            <button className="bd-btn" onClick={() => setOpen(false)} disabled={busy}>Later</button>
            {fresh.state === "changed" && <button className="bd-btn pri" onClick={() => go("update")} disabled={busy}>Update {n === 1 ? "1 card" : `${n} cards`}</button>}
            <button className={`bd-btn${fresh.state === "changed" ? "" : " pri"}`} onClick={() => go("draw")} disabled={busy}>Redraw</button>
          </div>
        </div>
      )}
    </>
  );
}

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
  // Bumped after a redraw or update is started, so the board is watched again until the new one lands.
  const [kick, setKick] = useState(0);
  const rewrite = async (mode: "draw" | "update") => {
    await (mode === "update" ? api.updateBoard(id) : api.writeBoard(id));
    setKick((k) => k + 1);
  };
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
  }, [id, kick]);

  if (error) return <div className="bd-msg">{error} <button className="bd-link" onClick={onHome}>Back to the flows</button></div>;
  if (!state) return <div className="bd-msg"><span className="spinner" /> Opening the board…</div>;
  if (!state.board) return <Drawing state={state} onHome={onHome} />;
  return <BoardView id={id} board={state.board} job={state.job} fresh={state.fresh} onRewrite={rewrite} repoName={repoName} onHome={onHome} onSettings={onSettings} />;
}

/** While a board is drawn: what's happening, how long is left, and the flow's outline to read meanwhile. */
function Drawing({ state, onHome }: { state: BoardState; onHome: () => void }) {
  const job = state.job && !state.job.finishedAt ? state.job : null;
  const now = useNow(!!job);
  const progress = useProgress(job, now);
  const failed = state.job?.finishedAt && state.job.error;
  const stopped = failed === "Stopped";
  const [asking, setAsking] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Same as the tray's stop: nothing half-drawn is kept, so there's nothing left to look at here.
  const stop = () => {
    setStopping(true);
    void api.stopBoard(state.flow.id).finally(onHome);
  };
  return (
    <div className="bd-stage bd-static">
      <div className="bd-wait">
        <div className="bd-wait-kick">Drawing the board</div>
        <h2>{state.flow.title}</h2>
        <div className="bd-wait-status">
          {failed ? null : <span className="spinner" aria-hidden="true" />}
          <span>{stopped ? "Stopped. Nothing half-drawn was kept." : failed ? `Couldn't draw it: ${state.job?.error}` : job?.stage ?? "Starting"}</span>
          {job && <span className="bd-wait-left">{timeLeft(job, now)}</span>}
        </div>
        {!failed && <div className="bd-wait-bar"><i style={{ transform: `scaleX(${job ? progress : 0.03})` }} /></div>}
        {failed && <button className="bd-btn pri" onClick={() => void api.writeBoard(state.flow.id)}>{stopped ? "Draw it again" : "Try again"}</button>}
        <div className="bd-sticky-static">
          <p>{state.flow.summary}</p>
          <p className="bd-wait-files">It runs through {state.flow.files.map((f) => f.split("/").pop()).join(" → ")}</p>
        </div>
        {asking ? (
          <div className="bd-wait-ask" role="alertdialog" aria-label="Stop drawing this board?">
            <p><b>Stop drawing this board?</b> Nothing half-drawn is kept. Going back keeps it drawing in the background.</p>
            <div>
              <button className="bd-btn" onClick={() => setAsking(false)} disabled={stopping}>Keep drawing</button>
              <button className="bd-btn danger" onClick={stop} disabled={stopping}>{stopping ? "Stopping…" : "Stop"}</button>
            </div>
          </div>
        ) : (
          <div className="bd-wait-foot">
            <button className="bd-link" onClick={onHome}>← Other flows</button>
            {job && <button className="bd-link bd-wait-stop" onClick={() => setAsking(true)}><Icon name="close" size={13} />Stop drawing</button>}
          </div>
        )}
      </div>
    </div>
  );
}


function BoardView({ id, board, job, fresh, onRewrite, repoName, onHome, onSettings }: {
  id: string; board: Board; job: BoardState["job"]; fresh: BoardState["fresh"]; onRewrite: (mode: "draw" | "update") => Promise<void>;
  repoName: string; onHome: () => void; onSettings: () => void;
}) {
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
  const [voiceMenu, setVoiceMenu] = useState(false);
  // A "Why?" from the tour: the question it asked, and whether the tour was playing when it was asked.
  const [why, setWhy] = useState<{ q: string; was: boolean } | null>(null);
  const think = useStore(thinkStore);
  const live = useRef({ rate, speak, chat, think });
  live.current = { rate, speak, chat, think };

  useEffect(() => {
    if (!stage.current || !capT.current || !capP.current) return;
    const narrow = () => (stage.current?.clientWidth ?? 1000) < 700;
    const e = new BoardEngine(stage.current, board, {
      caption: { title: capT.current, text: capP.current },
      onState: setEs,
      rate: () => live.current.rate,
      voice: (at, beat, signal) => (live.current.speak ? api.boardVoice(id, at, beat, signal).catch(() => null) : Promise.resolve(null)),
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
      thinkPause: () => live.current.think,
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

  // A click outside the voice menu (or on its button again) closes it.
  useEffect(() => {
    if (!voiceMenu) return;
    const down = (ev: PointerEvent) => {
      if (!(ev.target as Element).closest?.(".set-menu, .bd-voice-more")) setVoiceMenu(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [voiceMenu]);

  const e = engine.current;
  // A reveal shows what it rests on: its label and lines, under the caption.
  const step = es ? board.steps[es.step] : undefined;
  const said = es?.beat ? step?.beats[es.beat.i] : null;
  const paused = !!e?.isPaused();
  const checking = board.status === "checking" && !!job && !job.finishedAt;
  return (
    <div className="bd-root" ref={root}>
      <div className="bd-stage" ref={stage} />
      <div className="bd-fl bd-brand">
        <button className="bd-back" onClick={onHome} title="All flows" aria-label="All flows"><Icon name="back" size={18} /></button>
        <span className="bd-brand-t"><b>{board.title}</b><small>{repoName}</small></span>
        {board.updated && <span className="bd-updated" title={`Updated ${new Date(board.updated.at).toLocaleString()}: rewrote ${board.updated.cards.join(", ")} (steps ${board.updated.steps.join(", ") || "none"}); the rest is as first drawn.${board.notes.some((n) => n.includes("reworded")) ? " " + board.notes.filter((n) => n.includes("reworded")).join("; ") + "." : ""}`}>updated · {board.updated.cards.length} {board.updated.cards.length === 1 ? "card" : "cards"}</span>}
        {checking && <span className="bd-checking" title="A second reader is checking every claim against the code; the dots on the notes update when it's done">double-checking</span>}
      </div>
      <Rewrite job={job} fresh={fresh} onRewrite={onRewrite} />
      <ThemeButton className="bd-fl bd-gear bd-theme" />
      <button className="bd-fl bd-gear" onClick={onSettings} aria-label="Settings" title="Settings: voice, Claude"><Icon name="settings" size={18} /></button>
      {/* Out of the way, as in FigJam: zoom in, zoom out, and reset to the whole board. */}
      <div className="bd-zoomp" role="group" aria-label={`Zoom, now ${Math.round((es?.zoom ?? 0.5) * 100)}%`}>
        <button onClick={() => e?.zoom(1.25)} aria-label="Zoom in" title="Zoom in"><Icon name="plus" size={14} /></button>
        <button onClick={() => e?.zoom(0.8)} aria-label="Zoom out" title="Zoom out"><Icon name="minus" size={14} /></button>
        <button onClick={() => void e?.fit()} aria-label="Reset: fit the board (F)" title="Reset: fit the board (F)"><Icon name="fit" size={13} /></button>
      </div>

      {voiceMenu && <div className="bd-voice-menu"><VoiceMenu onChange={() => e?.voiceChanged()} onClose={() => setVoiceMenu(false)} /></div>}
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
          {es && <Holding board={board} at={es.step} />}
          {(said?.kind === "reveal" || said?.kind === "point") && said.claim && <Said claim={said.claim} checking={checking} className="bare" />}
          {said?.kind === "say" && said.analogy && <p className="bd-note" title="A picture to hold on to, not a claim about the code">An analogy</p>}
          {step?.part === "flow" && !said?.claim && <Travels board={board} route={step.route} />}
          {step?.part === "intro" && !said?.claim && !said?.analogy && (board.example
            ? <div className="bd-ex"><p className="bd-note">The example comes from the repo's tests</p><Said claim={board.example} checking={checking} className="bare" /></div>
            : <p className="bd-note">The example is made up for this tour</p>)}
        </div>
        <div className="bd-bar-ctl">
          <button onClick={() => e?.goStep((es?.step ?? 0) - 1)} aria-label="Previous step (←)" data-tip="Previous step (←)"><Icon name="prev" size={16} fill /></button>
          <button className="bd-play" onClick={() => e?.play()} aria-label={!es?.playing || paused ? "Play (space)" : "Pause (space)"} data-tip={!es?.playing || paused ? "Play (space)" : "Pause (space)"}>{!es?.playing || paused ? <Icon name="play" size={15} fill /> : <Icon name="pause" size={15} fill />}{!es?.playing ? "Play" : paused ? "Resume" : "Pause"}</button>
          <button onClick={() => e?.goStep((es?.step ?? 0) + 1)} aria-label="Next step (→)" data-tip="Next step (→)"><Icon name="next" size={16} fill /></button>
          <div className="bd-steps">
            {board.steps.map((st, i) => (
              <b key={i} role="button" aria-label={`Step ${i + 1}: ${PART[st.part]}`} title={PART[st.part]} className={`${i === es?.step ? "on" : i < (es?.step ?? 0) ? "done" : ""}${i > 0 && board.steps[i - 1]!.part !== st.part ? " gap" : ""}`} onClick={() => e?.goStep(i)} />
            ))}
          </div>
          <span className="bd-bar-gap" />
          <button onClick={() => rateStore.set(nextRate(rate))} aria-label={`Speed, now ${rate}×`} data-tip={`Speed: ${rate}× (click for ${nextRate(rate)}×)`}>{rate}×</button>
          <button onClick={() => thinkStore.set(!think)} aria-pressed={think} className={think ? "on-soft" : ""} data-tip={think ? "Pausing after each question: click to stop" : "Pause after each question until you play on"} aria-label="Pause on questions"><Icon name="think" size={16} /></button>
          <button
            onClick={() => voiceOnStore.set(!voiceOn)}
            disabled={!voice?.available}
            aria-pressed={speak}
            aria-label={speak ? "Mute the narrator" : "Hear the narrator"}
            data-tip={!voice ? "Narrator" : voice.available ? (voiceOn ? "Mute the narrator" : "Hear the narrator") : voice.reason}
          ><Icon name={speak ? "sound" : "muted"} size={18} /></button>
          <button className={`bd-voice-more${voiceMenu ? " on" : ""}`} onClick={() => setVoiceMenu((o) => !o)} aria-expanded={voiceMenu} aria-haspopup="dialog" aria-label="Choose the narrator's voice" data-tip="Choose the narrator's voice"><Icon name="chevron" size={13} /></button>
          <button className={`bd-ask${chat ? " on" : ""}`} onClick={() => (chat ? closeChat() : setChat(true))} aria-pressed={chat} aria-label="Ask Docent" data-tip="Ask Docent about this board (/)">
            <Icon name="ask" size={16} /><span className="bd-ask-t">Ask</span>
          </button>
        </div>
      </div>
    </div>
  );
}
