import { createStore } from "./store.ts";

/** Whether the inspector is shown, and which group a canvas click asked to open. */
export const inspectorStore = createStore<{ open: boolean; focusGroup: string | null }>({
  open: typeof window === "undefined" || window.matchMedia("(min-width: 761px)").matches,
  focusGroup: null,
});

export const revealGroup = (group: string) => inspectorStore.set({ open: true, focusGroup: group });
