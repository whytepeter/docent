import { createStore } from "../../shared/state/store.ts";

export interface CodeTarget {
  path: string;
  /** Lines to highlight and scroll to. */
  focus?: [number, number];
}

export const codeSheet = createStore<CodeTarget | null>(null);

/** Open a file in the code sheet, scrolled to the given lines. */
export const openCode = (path: string, from?: number, to?: number) =>
  codeSheet.set({ path, ...(from ? { focus: [from, to ?? from] as [number, number] } : {}) });
