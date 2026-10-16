import { useEffect, useRef, useState } from "react";
import type { Job } from "@docent/contracts";

/** The current time, ticking every second while `on`, so waits show live elapsed and remaining time. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** "about 4 min left", in plain words; honest when it's running long. */
export function timeLeft(job: Job, now: number): string {
  if (!job.estimateSeconds) return "";
  const elapsed = (now - Date.parse(job.startedAt)) / 1000;
  const left = job.estimateSeconds - elapsed;
  if (left < -20) return "taking a little longer than usual";
  if (left < 60) return "less than a minute left";
  return `about ${Math.round(left / 60)} min left`;
}

/**
 * Progress from 0 to 1 that keeps moving between milestones (time against the estimate) and never goes
 * backwards when the estimate is refined, so a long wait doesn't look stuck.
 */
export function useProgress(job: Job | null | undefined, now: number): number {
  const best = useRef(0);
  const key = job?.startedAt;
  const seen = useRef(key);
  if (seen.current !== key) {
    seen.current = key;
    best.current = 0;
  }
  if (!job) return 0;
  if (job.finishedAt) return 1;
  const byWork = job.total ? (job.done.length + job.failed.length) / job.total : 0;
  const byTime = job.estimateSeconds ? (now - Date.parse(job.startedAt)) / 1000 / job.estimateSeconds : 0;
  best.current = Math.max(best.current, Math.min(0.97, Math.max(byWork, byTime * 0.97)));
  return best.current;
}
