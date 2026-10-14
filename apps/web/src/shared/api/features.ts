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

export async function refreshFeatures(): Promise<void> {
  const wasRunning = !!state?.job && !state.job.finishedAt;
  state = await api.features();
  emit();
  const running = !!state.job && !state.job.finishedAt;
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

export async function startDiscovery() {
  await api.discover();
  await refreshFeatures();
}

export async function startVerify(id?: string) {
  await api.verify(id);
  await refreshFeatures();
}
