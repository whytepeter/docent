import { useSyncExternalStore } from "react";
import { hashToRoute, routeToHash, type Route } from "@docent/contracts";

/** Hash routing: every view has a URL, and back/forward work like a browser. */
const subscribe = (l: () => void) => (window.addEventListener("hashchange", l), () => window.removeEventListener("hashchange", l));

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return hashToRoute(hash);
}

export const navigate = (route: Route) => {
  const hash = routeToHash(route);
  if (window.location.hash !== hash) window.location.hash = hash;
};

/**
 * Which way the last move went on the zoom ladder (system → area → file → function).
 * Deeper arrives as a zoom in, back up as a zoom out, so moving around feels like one continuous canvas.
 */
const LEVEL: Record<Route["view"], number> = { system: 0, review: 0, feature: 1, episode: 2, area: 1, file: 2, fn: 3, board: 1 };
let current = typeof window === "undefined" ? 0 : LEVEL[hashToRoute(window.location.hash).view];
let direction: "in" | "out" | "same" = "same";
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    const next = LEVEL[hashToRoute(window.location.hash).view];
    direction = next > current ? "in" : next < current ? "out" : "same";
    current = next;
  });
}
export const entryDirection = () => direction;
