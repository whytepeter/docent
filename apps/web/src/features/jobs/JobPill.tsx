import { api } from "../../shared/api/client.ts";
import { refreshFeatures, useFeatures } from "../../shared/api/features.ts";
import { Icon } from "../../shared/ui/index.ts";
import "./jobs.css";

const cancel = async () => {
  await api.cancelJob();
  await refreshFeatures();
};

/** A quiet floating pill while Claude works: what it's doing, how far it got, and a way to stop it. */
export function JobPill() {
  const s = useFeatures();
  const job = s?.job;
  if (!job) return null;
  const running = !job.finishedAt;
  if (!running && Date.now() - Date.parse(job.finishedAt!) > 8000) return null;
  return (
    <div className={`float job-pill${job.error ? " failed" : running || job.cancelled ? "" : " done"}`} role="status" aria-live="polite">
      {running ? <span className="spinner" /> : <span className="job-dot" />}
      <span>{job.error ? `${job.message}: ${job.error}` : job.message}</span>
      {job.kind === "verify" && job.total > 1 && (
        <span className="job-bar" aria-hidden="true"><i style={{ width: `${((job.done.length + job.failed.length) / job.total) * 100}%` }} /></span>
      )}
      {running && (
        <button className="tbtn job-cancel" onClick={() => void cancel()} aria-label="Stop" title="Stop. Features already finished stay saved.">
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
