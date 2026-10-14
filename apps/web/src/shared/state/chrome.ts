import { createStore } from "./store.ts";

/**
 * The floating panels over the canvas. The canvas always fills the window; panels float above it
 * and collapse out of the way. `insets` tell the diagram how much of each edge is covered,
 * so fitting the view centers the picture in the open space.
 */
const wide = typeof window === "undefined" || window.matchMedia("(min-width: 900px)").matches;

export const sidebarStore = createStore<boolean>(wide);

export const PANEL = { sidebar: 264, inspector: 440, gap: 12, top: 64, bottom: 64 } as const;

/** The details panel's width: dragged by its left edge, remembered in this browser. */
const WIDTH_KEY = "docent:inspector-width";
export const clampInspector = (w: number) =>
  Math.round(Math.max(340, Math.min(w, typeof window === "undefined" ? 900 : Math.min(900, window.innerWidth * 0.6))));
function savedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n ? clampInspector(n) : PANEL.inspector;
  } catch {
    return PANEL.inspector;
  }
}
export const inspectorWidth = createStore<number>(typeof window === "undefined" ? PANEL.inspector : savedWidth());
inspectorWidth.subscribe(() => {
  try {
    localStorage.setItem(WIDTH_KEY, String(inspectorWidth.get()));
  } catch {
    /* storage off: the width lasts for this session */
  }
});

export function insets(sidebarOpen: boolean, inspectorOpen: boolean, width: number = inspectorWidth.get()) {
  return {
    top: PANEL.top + 12,
    bottom: PANEL.bottom,
    left: sidebarOpen ? PANEL.sidebar + PANEL.gap * 2 : PANEL.gap * 2,
    right: inspectorOpen ? width + PANEL.gap * 2 : PANEL.gap * 2,
  };
}

/** Whether the details panel is actually on screen (it never shows on the overview). */
export const inspectorVisible = createStore<boolean>(false);
