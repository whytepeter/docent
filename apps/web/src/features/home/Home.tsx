import { type ReactNode, useEffect, useState } from "react";
import type { FlowsState, Job, ProjectOverview } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { Icon, Logo, ThemeButton } from "../../shared/ui/index.ts";
import { loadProgress, Said, type Progress } from "../board/index.ts";
import { timeLeft, useNow, useProgress } from "../jobs/index.ts";
import { useCodeVersion } from "../../shared/state/code.ts";
import "../board/board.css";
import "./home.css";

const running = (j: Job | null | undefined): j is Job => !!j && !j.finishedAt;

/** Where you are in a drawn tour: not started, stopped part-way, or watched. */
const progressLine = (p: Progress | null) =>
  !p || (p.step === 0 && !p.done) ? "ready to tour" : p.done ? "watched · tour it again" : `stopped at step ${p.step + 1} of ${p.steps} · pick up there`;

/**
 * The start: what the project does, then the flows worth a whiteboard. Both are written the first time a
 * repo opens (about a minute, no button) and cached after; a board not drawn yet is drawn when opened.
 */
export function Home({ repoName, switcher, onOpen, onBack, onSettings }: { repoName: string; switcher: ReactNode; onOpen: (id: string) => void; onBack: () => void; onSettings: () => void }) {
  const [state, setState] = useState<FlowsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  // Re-checked when the server has read the code again, so a board whose code changed is tagged without a reload.
  const codeVersion = useCodeVersion();
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await api.flows();
        if (!live) return;
        setState(s);
        // Nothing written and nothing running: start it. A job that failed waits for "Try again".
        const kicks = [
          ...(!s.flows && !s.job ? [api.proposeFlows()] : []),
          ...(!s.overview && !s.overviewJob ? [api.writeOverview()] : []),
        ];
        await Promise.all(kicks);
        if (kicks.length || running(s.job) || running(s.overviewJob) || s.drawing.some((d) => running(d.job))) t = setTimeout(() => void tick(), 1500);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tries, codeVersion]);
  const retry = (start: () => Promise<Job>) => void start().then(() => setTries((n) => n + 1), (e: Error) => setError(e.message));

  const job = running(state?.job) ? state.job : null;
  const now = useNow(!!job || running(state?.overviewJob) || (state?.drawing ?? []).some((d) => running(d.job)));
  const progress = useProgress(job, now);
  const flows = state?.flows?.flows ?? [];
  const ready = new Set(state?.ready ?? []);
  // Drawn boards whose cards' code changed since; opening one offers to update or redraw it.
  const stale = new Set(state?.stale ?? []);
  const drawing = new Map((state?.drawing ?? []).filter((d) => !d.job.done.includes("board") && !d.job.finishedAt).map((d) => [d.id, d.job]));
  const failed = state?.job?.finishedAt && state.job.error && !state.flows;

  return (
    <div className="bd-home">
      <div className="bd-home-bar">
        <button className="bd-home-brand bd-home-back" onClick={onBack} title="All projects" aria-label="Back to all projects">
          <span className="bd-home-back-i" aria-hidden="true"><Icon name="back" size={16} /></span>
          <Logo size={16} /><span className="bd-home-word">docent</span>
        </button>
        <span className="bd-home-slash" aria-hidden="true">/</span>
        {switcher}
        <ThemeButton className="bd-home-gear bd-home-theme" />
        <button className="bd-home-gear" onClick={onSettings} aria-label="Settings" title="Settings: voice, keys"><Icon name="settings" size={18} /></button>
      </div>
      <main className="bd-home-main">
        {error && <p className="bd-home-err">{error}</p>}
        {/* Nothing until the first answer (a few ms locally): a placeholder would only flash and jump. */}
        {state && <Overview name={repoName} overview={state.overview} job={state.overviewJob} now={now} onRetry={() => retry(api.writeOverview)} />}

        {state && <section className="bd-home-flows" aria-labelledby="bd-flows-h">
          <h2 id="bd-flows-h">What do you want to understand?</h2>
          <p className="bd-home-sub">Pick a flow. Docent draws it as a board from the real code and takes you through it: one request from start to end, what happens when it goes wrong, and why it is built that way.</p>
          {failed && (
            <p className="bd-home-err">
              Couldn't find the flows: {state?.job?.error}{" "}
              <button className="bd-link" onClick={() => retry(api.proposeFlows)}>Try again</button>
            </p>
          )}
          {!state?.flows && !failed && (
            <div className="bd-sticky-static bd-home-wait" role="status">
              <p>{job?.stage ?? "Reading the code"}…</p>
              <div className="bd-wait-bar"><i style={{ transform: `scaleX(${job ? progress : 0.04})` }} /></div>
              <p className="bd-wait-files">{job ? timeLeft(job, now) : "starting"}</p>
            </div>
          )}
          <div className="bd-home-grid">
            {flows.map((f, i) => (
              <button key={f.id} className={`bd-home-card${ready.has(f.id) ? " ready" : drawing.has(f.id) ? " drawing" : ""}`} onClick={() => onOpen(f.id)}>
                <span className="bd-num">{i + 1}</span>
                <span className="bd-home-t">
                  <b>{f.title}</b>
                  <span>{f.summary}</span>
                  <em>
                    {f.files.length} files ·{" "}
                    {ready.has(f.id) ? progressLine(loadProgress(repoName, f.id)) : drawing.has(f.id) ? `drawing now · ${timeLeft(drawing.get(f.id)!, now) || "almost done"}` : "not drawn yet · about 2 min"}
                  </em>
                </span>
                {ready.has(f.id) && !drawing.has(f.id) && (stale.has(f.id)
                  ? <span className="bd-home-ready stale" title="The code changed since this board was drawn; open it to update or redraw it">Code changed</span>
                  : <span className="bd-home-ready"><Icon name="check" size={12} weight="bold" />Ready</span>)}
                {drawing.has(f.id) && <span className="bd-home-ready drawing">Drawing</span>}
              </button>
            ))}
          </div>
        </section>}
      </main>
    </div>
  );
}

/** What the project does, in a minute of reading: two sentences, how it's built, its parts, what it talks to. */
function Overview({ name, overview, job, now, onRetry }: { name: string; overview: ProjectOverview | null; job: Job | null; now: number; onRetry: () => void }) {
  const progress = useProgress(running(job) && !overview ? job : null, now);
  const checking = overview?.status === "checking" && running(job);
  return (
    <section className="bd-ov" aria-labelledby="bd-ov-h" aria-busy={!overview}>
      <p className="bd-ov-kicker">
        What it does
        {checking && <span className="bd-checking">double-checking</span>}
      </p>
      <h1 id="bd-ov-h">{name}</h1>
      {overview ? (
        <>
          <Said claim={overview.what} checking={checking} className="lead" />
          <Said claim={overview.how} checking={checking} className="how" />
          {overview.parts.length > 0 && (
            <>
              <h3 className="bd-ov-h">Its parts <span>in the order a user's action meets them</span></h3>
              <ol className="bd-ov-parts">
                {overview.parts.map((p, i) => (
                  <li key={`${p.path}-${i}`} className="bd-ov-part">
                    <div className="bd-ov-part-h">
                      <span className="bd-ov-n">{i + 1}</span>
                      <b>{p.name}</b>
                    </div>
                    <code>{p.path}</code>
                    <Said claim={p.does} checking={checking} />
                  </li>
                ))}
              </ol>
            </>
          )}
          {overview.talksTo.length > 0 && (
            <>
              <h3 className="bd-ov-h">It talks to <span>outside this repo</span></h3>
              <ul className="bd-ov-out">
                {overview.talksTo.map((t, i) => (
                  <li key={`${t.name}-${i}`}>
                    <b>{t.name}</b>
                    <Said claim={t.does} checking={checking} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : job?.finishedAt && job.error ? (
        <p className="bd-home-err">
          Couldn't read what it does: {job.error} <button className="bd-link" onClick={onRetry}>Try again</button>
        </p>
      ) : (
        <div className="bd-ov-wait" role="status">
          <span className="bd-ov-sk" /><span className="bd-ov-sk" /><span className="bd-ov-sk short" />
          <p>
            <span>{job?.stage ?? "Reading the code"}…</span>
            <span>{running(job) ? timeLeft(job, now) : "starting"}</span>
          </p>
          <div className="bd-wait-bar"><i style={{ transform: `scaleX(${running(job) ? progress : 0.04})` }} /></div>
        </div>
      )}
    </section>
  );
}
