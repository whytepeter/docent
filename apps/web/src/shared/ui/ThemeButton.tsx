import { themeStore, type Theme } from "../state/theme.ts";
import { useStore } from "../state/store.ts";
import { Icon } from "./Icon.tsx";

const NEXT: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
const SHOW: Record<Theme, { name: string; icon: "sun" | "moon" | "screen" }> = {
  light: { name: "Light", icon: "sun" },
  dark: { name: "Dark", icon: "moon" },
  system: { name: "System", icon: "screen" },
};

/** One button: shows the theme in use and steps light → dark → system on each click. */
export function ThemeButton({ className = "" }: { className?: string }) {
  const theme = useStore(themeStore);
  const label = `Theme: ${SHOW[theme].name}. Click for ${SHOW[NEXT[theme]].name}`;
  return (
    <button className={className} onClick={() => themeStore.set(NEXT[theme])} aria-label={label} title={label}>
      <Icon name={SHOW[theme].icon} size={17} />
    </button>
  );
}
