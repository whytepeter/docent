import { createStore } from "./store.ts";

/** Playback speed for narration and typing, like a video player's. Remembered in this browser. */
export const RATES = [1, 1.25, 1.5, 2] as const;

function saved<T>(key: string, ok: (v: string) => T | null, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return (v === null ? null : ok(v)) ?? fallback;
  } catch {
    return fallback;
  }
}
function remember<T>(key: string, store: { get: () => T; subscribe: (l: () => void) => unknown }): void {
  store.subscribe(() => {
    try {
      localStorage.setItem(key, String(store.get()));
    } catch {
      /* storage off */
    }
  });
}

export const rateStore = createStore<number>(saved("docent:rate", (v) => ((RATES as readonly number[]).includes(Number(v)) ? Number(v) : null), 1.25));
remember("docent:rate", rateStore);
export const nextRate = (r: number) => RATES[(RATES.indexOf(r as (typeof RATES)[number]) + 1) % RATES.length]!;

/** Whether the narrator speaks (when a voice is set up in Settings). */
export const voiceOnStore = createStore<boolean>(saved("docent:voice", (v) => v !== "off", true));
voiceOnStore.subscribe(() => {
  try {
    localStorage.setItem("docent:voice", voiceOnStore.get() ? "on" : "off");
  } catch {
    /* storage off */
  }
});

/** "Pause on questions": after Docent asks, the tour waits until you play on. Off unless chosen; never automatic. */
export const thinkStore = createStore<boolean>(saved("docent:think", (v) => v === "on", false));
thinkStore.subscribe(() => {
  try {
    localStorage.setItem("docent:think", thinkStore.get() ? "on" : "off");
  } catch {
    /* storage off */
  }
});
