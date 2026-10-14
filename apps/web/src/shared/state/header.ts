import type { Route } from "@docent/contracts";
import { createStore } from "./store.ts";

/** What the toolbar shows for the current view. Each view sets it when its data arrives. */
export interface Header {
  title: string;
  subtitle?: string;
  crumbs: { label: string; route: Route }[];
}

export const headerStore = createStore<Header>({ title: "", crumbs: [] });
