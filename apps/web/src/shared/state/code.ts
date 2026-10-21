import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api/client.ts";
import { createStore } from "./store.ts";

/**
 * How many times the server has read the code again since it opened the folder. The server watches the folder
 * and re-reads it once edits settle; a screen that shows boards checks them again when this moves.
 */
export const codeVersionStore = createStore<number | null>(null);

const EVERY_MS = 3000;
let watchers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function check() {
  if (document.hidden) return;
  api.status().then((s) => codeVersionStore.set(s.version), () => {});
}

/** The code version, polled every few seconds while a screen that needs it is open and the tab is visible. */
export function useCodeVersion(): number | null {
  useEffect(() => {
    if (watchers++ === 0) {
      check();
      timer = setInterval(check, EVERY_MS);
      document.addEventListener("visibilitychange", check);
    }
    return () => {
      if (--watchers === 0) {
        clearInterval(timer);
        document.removeEventListener("visibilitychange", check);
      }
    };
  }, []);
  return useSyncExternalStore(codeVersionStore.subscribe, codeVersionStore.get);
}
