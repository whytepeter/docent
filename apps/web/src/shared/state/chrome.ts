import { createStore } from "./store.ts";

/**
 * The floating panels over the canvas. The canvas always fills the window; panels float above it
 * and collapse out of the way. `insets` tell the diagram how much of each edge is covered,
 * so fitting the view centers the picture in the open space.
 */
const wide = typeof window === "undefined" || window.matchMedia("(min-width: 900px)").matches;

export const sidebarStore = createStore<boolean>(wide);

export const PANEL = { sidebar: 264, inspector: 384, gap: 12, top: 64, bottom: 64 } as const;

export function insets(sidebarOpen: boolean, inspectorOpen: boolean) {
  return {
    top: PANEL.top + 12,
    bottom: PANEL.bottom,
    left: sidebarOpen ? PANEL.sidebar + PANEL.gap * 2 : PANEL.gap * 2,
    right: inspectorOpen ? PANEL.inspector + PANEL.gap * 2 : PANEL.gap * 2,
  };
}

/** Whether the details panel is actually on screen (it never shows on the overview). */
export const inspectorVisible = createStore<boolean>(false);
