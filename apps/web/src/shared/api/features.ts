import { useEffect, useSyncExternalStore } from "react";
import type { FeaturesState } from "@docent/contracts";
import { api } from "./client.ts";
import { invalidateAll } from "./useQuery.ts";

/**
 * The feature map and any running job, shared by every view. Polls while a job runs,
 * and refreshes the rest of the app when one finishes.
 */
let state: FeaturesState | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

const emit = () => listeners.forEach((l) => l());

const busy = (s: FeaturesState | null) => !!s && ((!!s.job && !s.job.finishedAt) || (!!s.episodeJob && !s.episodeJob.finishedAt));

export async function refreshFeatures(): Promise<void> {
  const wasRunning = busy(state);
  const before = state ? `${state.job?.done.length}:${state.episodeJob?.done.length}` : "";
  state = await api.features();
  emit();
  const running = busy(state);
  // Each finished feature (or episode) shows up right away, not only when the whole job ends.
  if (running && before && before !== `${state.job?.done.length}:${state.episodeJob?.done.length}`) invalidateAll();
  clearTimeout(timer);
  if (running) timer = setTimeout(() => void refreshFeatures(), 2000);
  else if (wasRunning) invalidateAll();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  if (!state && !loading) loading = refreshFeatures().finally(() => (loading = null));
  return () => listeners.delete(l);
};

export function useFeatures(): FeaturesState | null {
  const s = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {}, []);
  return s;
}

/** The one-click start: find the features if needed, then get every one ready. */
export async function startPrepare() {
  await api.prepare();
  await refreshFeatures();
}

export async function startEpisode(id: string) {
  await api.writeEpisode(id);
  await refreshFeatures();
}

export async function startDiscovery() {
  await api.discover();
  await refreshFeatures();
}

export async function startVerify(id?: string) {
  await api.verify(id);
  await refreshFeatures();
}
