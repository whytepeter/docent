import { useEffect, useState, useSyncExternalStore } from "react";

/** A tiny request cache: one entry per key, shared by every component that asks. */
const cache = new Map<string, Promise<unknown>>();
let generation = 0;
const listeners = new Set<() => void>();

/** Drop everything (after the repo is re-read) and let mounted queries refetch. */
export function invalidateAll(): void {
  cache.clear();
  generation += 1;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

export interface QueryState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

export function useQuery<T>(key: string | null, load: () => Promise<T>): QueryState<T> {
  const gen = useSyncExternalStore(subscribe, () => generation);
  const [state, setState] = useState<QueryState<T> & { key: string | null }>({ key: null, data: undefined, error: undefined, loading: !!key });

  useEffect(() => {
    if (!key) return;
    let live = true;
    let promise = cache.get(key) as Promise<T> | undefined;
    if (!promise) {
      promise = load();
      cache.set(key, promise);
      promise.catch(() => cache.delete(key));
    }
    setState((s) => (s.key === key ? { ...s, loading: true } : { key, data: undefined, error: undefined, loading: true }));
    promise.then(
      (data) => live && setState({ key, data, error: undefined, loading: false }),
      (error: Error) => live && setState({ key, data: undefined, error, loading: false }),
    );
    return () => {
      live = false;
    };
    // `load` is derived from `key`; refetch only when the key or generation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, gen]);

  return state.key === key ? state : { data: undefined, error: undefined, loading: !!key };
}
