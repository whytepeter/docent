import type { Feature } from "@docent/contracts";
import { createStore } from "../../shared/state/store.ts";

/** The user's working copy of the feature map while reviewing it, and which feature is selected. */
export const reviewStore = createStore<{ draft: Feature[] | null; selected: string | null; dirty: boolean }>({ draft: null, selected: null, dirty: false });

export const updateDraft = (fn: (features: Feature[]) => Feature[]) =>
  reviewStore.set((s) => (s.draft ? { ...s, draft: fn(s.draft), dirty: true } : s));
