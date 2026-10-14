import { useFeatures } from "../../shared/api/features.ts";
import "./jobs.css";

/** A quiet floating pill while Claude works: what it's doing and how far it got. */
export function JobPill() {
  const s = useFeatures();
  const job = s?.job;
  if (!job) return null;
  const running = !job.finishedAt;
  if (!running && Date.now() - Date.parse(job.finishedAt!) > 8000) return null;
  return (
    <div className={`float job-pill${job.error ? " failed" : running ? "" : " done"}`} role="status" aria-live="polite">
      {running ? <span className="spinner" /> : <span className="job-dot" />}
      <span>{job.error ? `${job.message}: ${job.error}` : job.message}</span>
      {job.kind === "verify" && job.total > 1 && (
        <span className="job-bar" aria-hidden="true"><i style={{ width: `${((job.done.length + job.failed.length) / job.total) * 100}%` }} /></span>
      )}
    </div>
  );
}
