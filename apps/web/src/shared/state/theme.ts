import { createStore } from "./store.ts";

/** Light, dark, or whatever the system says. Remembered in this browser; applied as data-theme on <html>. */
export type Theme = "system" | "light" | "dark";

const KEY = "docent:theme";
function load(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const themeStore = createStore<Theme>(load());

const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
/** The theme actually showing. */
export const shownTheme = (t: Theme = themeStore.get()): "light" | "dark" => (t === "system" ? (dark() ? "dark" : "light") : t);

function apply() {
  const t = themeStore.get();
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* storage off */
  }
}
apply();
themeStore.subscribe(apply);
