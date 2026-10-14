import { useEffect, useMemo, useRef, useState } from "react";
import type { Episode, EpisodeState, VoiceClip } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { refreshFeatures, useFeatures } from "../../shared/api/features.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { cardHeight, Diagram, hueFromPath, reducedMotion, type DiagramEdge, type DiagramNode } from "../../shared/graph/index.ts";
import { headerStore } from "../../shared/state/header.ts";
import { sidebarStore } from "../../shared/state/chrome.ts";
import { inspectorStore } from "../../shared/state/inspector.ts";
import { navigate } from "../../shared/state/router.ts";
import { sceneStore } from "../../shared/state/scene.ts";
import { useStore } from "../../shared/state/store.ts";
import { Icon, shortPath } from "../../shared/ui/index.ts";
import { CodeView, openCode } from "../code/index.ts";
import { duration, flatten, go, openEpisode, playerStore, restart, set, syncScene, voiceStore, type Flat } from "./player.ts";
import "./episode.css";

type Claim = Episode["selfCheck"][number]["answer"];

const BOX_W = 214;
const GAP_X = 96;
const GAP_Y = 36;
const KIND: Record<string, { kicker: string; icon: DiagramNode["icon"] }> = {
  screen: { kicker: "Screen", icon: "component" },
  code: { kicker: "Code", icon: "fn" },
  service: { kicker: "Outside the repo", icon: "area" },
  external: { kicker: "Outside the repo", icon: "area" },
  data: { kicker: "Data", icon: "file" },
};
const LABEL: Record<string, string> = {
  confirmed: "Confirmed · read in the code, citation checked, and a second reader couldn't refute it",
  inferred: "Inferred · a reasoned guess",
  unknown: "Unknown · can't be established from this repo",
  record: "Record · from commit history",
};

export const useEpisode = (id: string) => {
  const s = useFeatures();
  const job = s?.job?.kind === "episode" ? `${s.job.startedAt}:${s.job.finishedAt ?? ""}` : "";
  return useQuery(`episode:${id}:${job}`, () => api.episode(id));
};

/** The cast in lanes, left to right in the order things happen. Few boxes, each standing for real code. */
function layout(e: Episode): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const lanes = [...new Set(e.cast.map((c) => c.lane))].sort((a, b) => a - b);
  const h = cardHeight({ kicker: true });
  const nodes: DiagramNode[] = [];
  for (const [col, lane] of lanes.entries()) {
    const inLane = e.cast.filter((c) => c.lane === lane);
    const total = inLane.length * h + (inLane.length - 1) * GAP_Y;
    inLane.forEach((c, i) => {
      const kind = KIND[c.kind] ?? KIND.code!;
      nodes.push({
        id: c.id, x: col * (BOX_W + GAP_X), y: -total / 2 + i * (h + GAP_Y), w: BOX_W, h,
        kicker: kind.kicker, title: c.title, icon: kind.icon,
        sub: c.file ? `${shortPath(c.file, 2)}${c.start ? ` · ${c.start}–${c.end}` : ""}` : "not in this repo",
        hue: c.file ? hueFromPath(c.file) : "other",
        onClick: () => set({ focus: c.id, playing: false }),
      });
    });
  }
  const edges: DiagramEdge[] = e.links.map((l) => ({ id: l.id, from: l.from, to: l.to, label: l.label }));
  return { nodes, edges };
}

function Evidence({ claim }: { claim: Claim }) {
  return (
    <span className="ep-evidence">
      <span className={`dot ${claim.label}`} title={claim.review?.verdict === "upheld" ? `${LABEL[claim.label]}: ${claim.review.reason}` : LABEL[claim.label]} />
      {claim.evidence.map((e, j) => (
        <button key={j} className={`ev-chip${e.check.ok ? "" : " bad"}`} title={e.check.ok ? `${e.file}:${e.start}–${e.end}` : e.check.reason} onClick={() => openCode(e.file, e.start, e.end)}>
          {shortPath(e.file, 1)}:{e.start}{e.end !== e.start ? `–${e.end}` : ""}
        </button>
      ))}
      {claim.label === "record" && claim.commit && <span className="ev-chip static">commit {claim.commit.slice(0, 7)}</span>}
    </span>
  );
}

function Taken({ claim }: { claim: Claim }) {
  return claim.checkNote ? <p className="ep-note">Docent first said “{claim.claimedLabel}”; {claim.checkNote}.</p> : null;
}

const WORDS_PER_SECOND = 2.6;
/** How long a finished line stays before the next step. */
const HOLD_MS = 1100;

/** Longest wait for a step's voice clip before the line plays at the estimated pace instead. */
const CLIP_WAIT_MS = 8000;

/**
 * The narration appears word by word while the episode plays, and the step moves on when the line is done,
 * so text, voice and pacing run on one clock. With a voice clip, each word appears when it is spoken (the
 * provider's word timestamps); without one, at an estimated speaking pace. Pausing freezes both mid-line, and
 * playing again carries on from that word. Words not yet said keep their place, so the bar never jumps.
 * Stepping by hand, or reduced motion, shows the whole line at once.
 */
function Narration({ text, playing, clip, onDone }: { text: string; playing: boolean; clip: VoiceClip | null | "loading"; onDone: () => void }) {
  const words = useMemo(() => text.split(/(\s+)/), [text]);
  const total = words.filter((w) => w.trim()).length;
  const [shown, setShown] = useState(playing && !reducedMotion() ? 0 : total);
  const [gaveUp, setGaveUp] = useState(false);
  const [ended, setEnded] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  const audio = useMemo(() => (clip && clip !== "loading" ? new Audio(clip.url) : null), [clip]);
  const voiced = !!audio && !gaveUp;
  const waiting = clip === "loading" && !gaveUp;

  useEffect(() => () => audio?.pause(), [audio]);
  // A clip that never arrives doesn't hold the episode hostage.
  useEffect(() => {
    if (!waiting || !playing) return;
    const t = setTimeout(() => setGaveUp(true), CLIP_WAIT_MS);
    return () => clearTimeout(t);
  }, [waiting, playing]);

  useEffect(() => {
    if (!playing || waiting) {
      audio?.pause();
      return;
    }
    if (reducedMotion() && !voiced) {
      setShown(total);
      return;
    }
    if (voiced && audio && clip && clip !== "loading") {
      // The voice is the clock: count the words whose start has passed, mapped onto the words on screen.
      const onEnd = () => setEnded(true);
      audio.addEventListener("ended", onEnd);
      audio.play().catch(() => setGaveUp(true));
      const spokenMax = Math.max(1, clip.words.length);
      const t = setInterval(() => {
        const at = audio.currentTime;
        const spoken = clip.words.filter((w) => w.start <= at).length;
        setShown(reducedMotion() ? total : Math.min(total, clip.words.length === total ? spoken : Math.round((spoken / spokenMax) * total)));
      }, 50);
      return () => {
        clearInterval(t);
        audio.removeEventListener("ended", onEnd);
        audio.pause();
      };
    }
    // No voice: an estimated speaking pace, counted from the clock so a throttled timer never slows it down.
    const start = performance.now() - (shown / WORDS_PER_SECOND) * 1000;
    const t = setInterval(() => setShown(Math.min(total, Math.floor(((performance.now() - start) / 1000) * WORDS_PER_SECOND))), 80);
    return () => clearInterval(t);
    // `shown` is read once when playback (re)starts; it isn't a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, playing, total, voiced, waiting, audio, clip]);

  // The step is over when the voice ends (or, silent, when the last word shows), after a short hold.
  const finished = voiced ? ended : !waiting && shown >= total;
  useEffect(() => {
    if (!playing || !finished) return;
    setShown(total);
    const t = setTimeout(() => done.current(), HOLD_MS);
    return () => clearTimeout(t);
  }, [playing, finished, total]);

  let n = 0;
  return (
    <p className={`ep-say${waiting && playing ? " waiting" : ""}`} aria-label={text}>
      {words.map((w, i) => (w.trim() ? <span key={i} className={n++ < shown ? "said" : "unsaid"} aria-hidden="true">{w}</span> : w))}
    </p>
  );
}

/** Narration, caption, predict and controls, floating at the bottom of the canvas. */
function PlayBar({ e, flat, featureId }: { e: Episode; flat: Flat[]; featureId: string }) {
  const s = useStore(playerStore);
  const voiceOn = useStore(voiceStore);
  const { data: status } = useQuery("voice-status", api.voice);
  const speak = voiceOn && !!status?.available;
  const cur = flat[s.at];
  const { data: clip, error: clipError } = useQuery(speak && cur ? `clip:${featureId}:${s.at}` : null, () => api.voiceClip(featureId, s.at));
  // Fetch the next line while this one plays, so steps follow each other without a gap.
  const nextAt = flat[s.at + 1] ? s.at + 1 : null;
  useQuery(speak && nextAt !== null ? `clip:${featureId}:${nextAt}` : null, () => api.voiceClip(featureId, nextAt!));
  if (!cur) return null;
  const scene = e.scenes[cur.scene]!;
  const p = cur.data.predict;
  const waiting = !!p && s.picked === null;
  const sceneStarts = e.scenes.map((_, i) => flat.findIndex((f) => f.scene === i));
  return (
    <div className="float ep-bar" role="region" aria-label="Episode playback">
      <div className="ep-kicker">
        <span>Scene {cur.scene + 1} of {e.scenes.length} · {scene.title}</span>
        <span className="ep-scenes" aria-hidden="true">
          {sceneStarts.map((start, i) => <button key={i} className={i < cur.scene ? "done" : i === cur.scene ? "on" : ""} onClick={() => go(start, flat.length)} tabIndex={-1} />)}
        </span>
      </div>
      {waiting ? (
        <div className="ep-predict">
          {/* The question is asked aloud too; it never moves on by itself. */}
          <Narration key={`q${s.at}`} text={p.question} playing={s.playing && !s.focus} clip={!speak || clipError ? null : clip ?? "loading"} onDone={() => {}} />
          <div className="ep-options">
            {p.options.map((o, i) => <button key={i} className="ep-option" onClick={() => set({ picked: i, playing: false })}>{o.text}</button>)}
          </div>
        </div>
      ) : p ? (
        <div className="ep-predict">
          <p className={`ep-verdict ${p.options[s.picked!]?.correct ? "right" : "wrong"}`}>{p.options[s.picked!]?.correct ? "Right." : `Not quite. It's “${p.options.find((o) => o.correct)?.text}”.`}</p>
          <p className="ep-reveal">{p.reveal.text}</p>
          <Evidence claim={p.reveal} />
          <Taken claim={p.reveal} />
        </div>
      ) : (
        <>
          <Narration key={s.at} text={cur.data.say} playing={s.playing && !s.focus} clip={!speak || clipError ? null : clip ?? "loading"} onDone={() => go(s.at + 1, flat.length)} />
          <div className="ep-caption"><span>{cur.data.caption}</span><Evidence claim={cur.data.claim} /></div>
          <Taken claim={cur.data.claim} />
        </>
      )}
      <div className="ep-controls">
        <button className="tbtn" onClick={() => go(s.at - 1, flat.length)} disabled={s.at === 0} aria-label="Previous step ( ← )"><span className="flip"><Icon name="chevron" size={15} /></span></button>
        <button className="ep-play" onClick={() => (waiting ? undefined : set({ playing: !s.playing, focus: null }))} disabled={waiting} aria-label={s.playing ? "Pause (space)" : "Play (space)"}>
          <Icon name={s.playing && !waiting ? "stop" : "play"} size={14} weight="bold" />
        </button>
        <button className="tbtn" onClick={() => go(s.at + 1, flat.length)} disabled={waiting} aria-label="Next step ( → )"><Icon name="chevron" size={15} /></button>
        <span className="ep-count">{s.at + 1} / {flat.length}</span>
        <button
          className="tbtn ep-voice"
          aria-pressed={speak}
          disabled={!status?.available}
          onClick={() => voiceStore.set(!voiceOn)}
          title={!status ? "" : !status.available ? status.reason : clipError ? `Voice failed: ${clipError.message}` : voiceOn ? "Mute the narrator" : "Hear the narrator"}
          aria-label={speak ? "Mute the narrator" : "Hear the narrator"}
        >
          <Icon name={speak ? "sound" : "muted"} size={15} />
        </button>
        {s.focus && <button className="link ep-back" onClick={() => set({ focus: null, playing: true })}>Back to the episode</button>}
      </div>
    </div>
  );
}

function IntroCard({ e }: { e: Episode }) {
  return (
    <div className="float ep-card" role="dialog" aria-label={e.title}>
      <div className="ep-card-kicker">Episode</div>
      <h2>{e.title}</h2>
      <p>{e.intro}</p>
      <div className="analogy"><b>Think of it like this.</b> {e.analogy}</div>
      <p className="ep-meta">{e.scenes.length} scenes · about {Math.round(e.scenes.flatMap((s) => s.steps).reduce((t, st) => t + duration(st.say), 0) / 60000)} minutes · pauses to ask what you think will happen</p>
      <button className="ep-start" onClick={restart} autoFocus><Icon name="play" size={14} weight="bold" />Start</button>
    </div>
  );
}

function EndCard({ e }: { e: Episode }) {
  return (
    <div className="float ep-card wide" role="dialog" aria-label="Check yourself">
      <div className="ep-card-kicker">Check yourself</div>
      <h2>Can you answer these without help?</h2>
      <p>Try each one before you open it.</p>
      {e.selfCheck.map((q, i) => (
        <details key={i} className="ep-check">
          <summary>{q.question}</summary>
          <p>{q.answer.text}</p>
          <Evidence claim={q.answer} />
          <Taken claim={q.answer} />
        </details>
      ))}
      <div className="ep-exercise">
        <div className="ep-card-kicker">Try it in the repo</div>
        <p><b>{e.exercise.task}</b></p>
        <details><summary>Hint</summary><p>{e.exercise.hint}</p></details>
        <p className="ep-meta">How you'll know: {e.exercise.check}</p>
      </div>
      <div className="ep-end-actions">
        <button className="ep-start" onClick={restart}><Icon name="play" size={14} weight="bold" />Watch again</button>
      </div>
    </div>
  );
}

function Empty({ data }: { data: EpisodeState }) {
  const s = useFeatures();
  const running = !!s?.job && !s.job.finishedAt;
  const write = async () => {
    await api.writeEpisode(data.feature.id);
    await refreshFeatures();
  };
  return (
    <div className="center-msg">
      <div className="feature-empty">
        <h2>{data.feature.name}</h2>
        {data.verified ? (
          <>
            <p>No episode yet. Docent writes it from what verification established, checks every claim, then you can watch it.</p>
            <button className="ep-start" disabled={running} onClick={() => void write()}>{running && s?.job?.kind === "episode" ? "Writing…" : "Write the episode"}</button>
          </>
        ) : (
          <p>Verify this feature first: episodes are built only from checked claims.</p>
        )}
      </div>
    </div>
  );
}

/** Learn mode: the feature's episode on the canvas, with narration, moving packets and predict pauses. */
export function EpisodeCanvas({ id }: { id: string }) {
  const { data, error } = useEpisode(id);
  const s = useStore(playerStore);
  const e = data?.episode ?? null;
  const flat = useMemo(() => (e ? flatten(e) : []), [e]);
  const graph = useMemo(() => (e ? layout(e) : null), [e]);

  useEffect(() => openEpisode(id), [id]);
  useEffect(() => {
    if (data) document.title = `${data.feature.name} · episode · Docent`;
    if (data) headerStore.set({ title: e?.title ?? data.feature.name, crumbs: [{ label: "Overview", route: { view: "system" } }, { label: data.feature.name, route: { view: "feature", id } }] });
  }, [data, e, id]);
  useEffect(() => {
    if (s.id === id) syncScene(e, s);
  }, [e, s, id]);
  useEffect(() => () => sceneStore.set(null), []);
  // Playing is one focus: the map folds away (one key brings it back) and the code panel follows along.
  useEffect(() => {
    if (s.phase !== "play") return;
    inspectorStore.set((v) => ({ ...v, open: true }));
    sidebarStore.set(false);
  }, [s.phase]);

  // Ordinary steps move on when their narration finishes (see Narration). A predict step waits for an answer;
  // once answered and played on, the reveal holds for its reading time.
  const cur = flat[s.at];
  useEffect(() => {
    if (!s.playing || s.phase !== "play" || !cur?.data.predict || s.picked === null || s.focus) return;
    const t = setTimeout(() => go(s.at + 1, flat.length), duration(cur.data.predict ? cur.data.predict.reveal.text : cur.data.say));
    return () => clearTimeout(t);
  }, [s.playing, s.phase, s.at, s.focus, s.picked, cur, flat.length]);

  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.target instanceof Element && k.target.closest("input, textarea, [contenteditable], button")) return;
      const st = playerStore.get();
      if (st.phase !== "play") return;
      if (k.key === " ") (k.preventDefault(), set({ playing: !st.playing, focus: null }));
      else if (k.key === "ArrowRight") go(st.at + 1, flat.length);
      else if (k.key === "ArrowLeft") go(st.at - 1, flat.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat.length]);

  if (error) return <div className="center-msg">Couldn’t load the episode: {error.message}</div>;
  if (!data) return null;
  if (!e || !graph) return <Empty data={data} />;
  return (
    <>
      <Diagram nodes={graph.nodes} edges={graph.edges} edgeShape="curve" edgeLabels={s.phase !== "play"} noDive label={`${e.title}, the episode`} />
      {data.stale && <div className="float ep-stale">The code changed since this episode was written. <button className="link" onClick={() => void api.writeEpisode(id).then(refreshFeatures)}>Write it again</button></div>}
      {s.phase === "intro" && <IntroCard e={e} />}
      {s.phase === "end" && <EndCard e={e} />}
      {s.phase === "play" && <PlayBar e={e} flat={flat} featureId={id} />}
    </>
  );
}

/** The details panel: the code for the current step, or the box the learner clicked to explore. */
export function EpisodeInspector({ id }: { id: string }) {
  const { data } = useEpisode(id);
  const s = useStore(playerStore);
  const e = data?.episode;
  if (!e) return null;
  const flat = flatten(e);
  const cur = flat[s.at];
  const box = s.focus ? e.cast.find((c) => c.id === s.focus) : null;
  if (box) {
    return (
      <>
        <div className="i-head">
          <div className="kick">{KIND[box.kind]?.kicker ?? "Box"}</div>
          <div className="i-title">{box.title}</div>
          {box.file && <div className="i-sub">{box.file}{box.start ? `:${box.start}–${box.end}` : ""}</div>}
          <div className="i-meta">
            {box.symbol && <button className="link" onClick={() => navigate({ view: "fn", id: box.symbol })}>Open in Work mode</button>}
            {!box.symbol && box.file && <button className="link" onClick={() => navigate({ view: "file", path: box.file })}>Open the file</button>}
            <button className="link" onClick={() => set({ focus: null, playing: true })}>Back to the episode</button>
          </div>
        </div>
        {box.file ? <CodeView path={box.file} from={box.start || undefined} to={box.start ? Math.min(box.end, box.start + 80) : 60} /> : <p className="feature-summary muted">This runs outside the repo, so Docent can only see how the code talks to it.</p>}
      </>
    );
  }
  if (s.phase !== "play" || !cur) {
    return (
      <>
        <div className="i-head">
          <div className="kick">In this episode</div>
          <div className="i-title">{e.title}</div>
        </div>
        <ol className="ep-outline">
          {e.scenes.map((sc, i) => (
            <li key={i}>
              <button className="row" onClick={() => (go(flat.findIndex((f) => f.scene === i), flat.length), set({ playing: true }))}>
                <span className="step-n">{i + 1}</span>
                <span className="grow"><b>{sc.title}</b><span>{sc.objective}</span></span>
              </button>
            </li>
          ))}
        </ol>
      </>
    );
  }
  const scene = e.scenes[cur.scene]!;
  return (
    <>
      <div className="i-head">
        <div className="kick">Scene {cur.scene + 1} · {scene.title}</div>
        <p className="feature-summary">{scene.objective}</p>
      </div>
      {cur.data.code ? (
        <CodeView key={`${cur.data.code.file}:${cur.data.code.start}`} path={cur.data.code.file} from={Math.max(1, cur.data.code.start - 4)} to={cur.data.code.end + 4} focus={[cur.data.code.start, cur.data.code.end]} scrollToFocus />
      ) : (
        <p className="feature-summary muted">No code for this step: it's about how the pieces fit.</p>
      )}
    </>
  );
}

/** A quiet pill on other views while an episode is paused mid-way: one click returns to the same step. */
export function ResumeEpisode({ onEpisode }: { onEpisode: boolean }) {
  const s = useStore(playerStore);
  const [hidden, setHidden] = useState(false);
  if (onEpisode || hidden || !s.id || s.phase !== "play") return null;
  return (
    <div className="float ep-resume">
      <button className="link" onClick={() => navigate({ view: "episode", id: s.id! })}><Icon name="play" size={13} weight="bold" />Back to the episode, step {s.at + 1}</button>
      <button className="tbtn" onClick={() => setHidden(true)} aria-label="Dismiss"><Icon name="close" size={13} /></button>
    </div>
  );
}
