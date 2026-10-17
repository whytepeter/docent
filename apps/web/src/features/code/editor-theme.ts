import type { BundledTheme } from "shiki";
import { createStore } from "../../shared/state/store.ts";

/**
 * The editor theme: the colours code is shown in, on the board's cards and in the code sheet, whatever the
 * page's own light or dark. Remembered in this browser.
 */
export const EDITOR_THEMES: { id: BundledTheme; name: string }[] = [
  { id: "github-dark-default", name: "Dark" },
  { id: "github-light", name: "Light" },
];
const DEFAULT: BundledTheme = "github-dark-default";

const KEY = "docent:editor-theme";
function load(): BundledTheme {
  try {
    const v = localStorage.getItem(KEY);
    return EDITOR_THEMES.some((t) => t.id === v) ? (v as BundledTheme) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export const editorThemeStore = createStore<BundledTheme>(load());

editorThemeStore.subscribe(() => {
  try {
    const id = editorThemeStore.get();
    if (id === DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch {
    /* storage off: the choice lasts until reload */
  }
});
