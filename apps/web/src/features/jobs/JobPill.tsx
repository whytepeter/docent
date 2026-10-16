import type { Job } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { refreshFeatures, useFeatures } from "../../shared/api/features.ts";
import { Icon } from "../../shared/ui/index.ts";
import { timeLeft, useNow, useProgress } from "./time.ts";
import "./jobs.css";

const cancel = async () => {
  await api.cancelJob();
  await refreshFeatures();
};

/** Recently finished jobs linger briefly, so the result is seen. */
const visible = (job: Job | null | undefined, now: number) => !!job && (!job.finishedAt || now - Date.parse(job.finishedAt) < 8000);

/**
 * A quiet floating panel while Claude works: what's happening now, which features, how far along and how long
 * is left, and a way to stop. Episode writing shows here too unless its own screen is open.
 */
export function JobPill({ hideEpisode = false }: { hideEpisode?: boolean }) {
  const s = useFeatures();
  const running = (!!s?.job && !s.job.finishedAt) || (!!s?.episodeJob && !s.episodeJob.finishedAt);
  const now = useNow(running);
  const jobs = [s?.job, hideEpisode ? null : s?.episodeJob].filter((j): j is Job => visible(j, now));
  if (!jobs.length) return null;
  return (
    <div className="job-stack">
      {jobs.map((job) => <JobRow key={job.startedAt} job={job} now={now} />)}
    </div>
  );
}

function JobRow({ job, now }: { job: Job; now: number }) {
  const running = !job.finishedAt;
  const progress = useProgress(job, now);
  const counted = job.total > 1 && (job.kind === "prepare" || job.kind === "verify");
  const active = job.active?.length ? job.active.join(", ") : "";
  return (
    <div className={`float job-pill${job.error ? " failed" : running || job.cancelled ? "" : " done"}`} role="status" aria-live="polite">
      <div className="job-line">
        {running ? <span className="spinner" /> : <span className="job-dot" />}
        <span className="job-main">{job.error ? `${job.message}: ${job.error}` : running && job.stage ? job.stage : job.message}</span>
        {running && counted && <span className="job-count">{job.done.length} of {job.total} ready</span>}
        {running && (
          <button className="tbtn job-cancel" onClick={() => void cancel()} aria-label="Stop" title="Stop. Anything already finished stays saved.">
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {running && (
        <div className="job-sub">
          {active && <span className="job-active" title={active}>Now: {active}</span>}
          <span className="job-left">{timeLeft(job, now)}</span>
        </div>
      )}
      {running && <span className="job-bar" aria-hidden="true"><i style={{ transform: `scaleX(${progress})` }} /></span>}
    </div>
  );
}
