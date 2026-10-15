import { createStore } from "./store.ts";

/** What the canvas shows right now, published by the diagram so questions can point at it. */
export interface CanvasContents {
  boxes: { id: string; title: string; sub?: string }[];
  links: { from: string; to: string; label?: string }[];
}
export const canvasStore = createStore<CanvasContents>({ boxes: [], links: [] });

/** One step of a scene: boxes to light, links to animate, and a caption. */
export interface SceneStep {
  nodes: string[];
  edges: { from: string; to: string }[];
  caption: string;
  /** Labeled things travelling along links in this step ("front photo", "403 · expired"), by edge id. */
  packets?: { edge: string; label: string; back: boolean; bad: boolean }[];
}

/** A scene playing on the canvas (an answer shown, later an episode). Null when nothing plays. */
export const sceneStore = createStore<{
  steps: SceneStep[];
  index: number;
  /** The learner paused: the canvas holds still. */
  paused?: boolean;
} | null>(null);

export const stopScene = () => sceneStore.set(null);
