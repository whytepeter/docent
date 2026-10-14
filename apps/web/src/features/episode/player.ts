import type { Episode } from "@docent/contracts";
import { sceneStore, type SceneStep } from "../../shared/state/scene.ts";
import { createStore } from "../../shared/state/store.ts";

export type Step = Episode["scenes"][number]["steps"][number];
export interface Flat { scene: number; step: number; data: Step }

/** Where the learner is in an episode. Kept per feature, so leaving and coming back resumes the same step. */
export interface PlayerState {
  id: string | null;
  phase: "intro" | "play" | "end";
  at: number;
  playing: boolean;
  /** The option picked at a predict step, or null before they answer. */
  picked: number | null;
  /** A box the learner clicked to look at; playback waits while they explore. */
  focus: string | null;
}

const KEY = (id: string) => `docent:episode:${id}`;
const blank = (id: string | null): PlayerState => ({ id, phase: "intro", at: 0, playing: false, picked: null, focus: null });
export const playerStore = createStore<PlayerState>(blank(null));

function remember(s: PlayerState) {
  if (!s.id) return;
  try {
    localStorage.setItem(KEY(s.id), JSON.stringify({ phase: s.phase, at: s.at }));
  } catch {
    /* storage off: resume works for this session only */
  }
}
playerStore.subscribe(() => remember(playerStore.get()));

/** Switch the player to an episode, picking up where the learner left it. */
export function openEpisode(id: string) {
  if (playerStore.get().id === id) return;
  let saved: Partial<PlayerState> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY(id)) ?? "{}") as Partial<PlayerState>;
  } catch {
    /* nothing saved */
  }
  playerStore.set({ ...blank(id), phase: saved.phase ?? "intro", at: saved.at ?? 0 });
}

export const flatten = (e: Episode): Flat[] => e.scenes.flatMap((s, scene) => s.steps.map((data, step) => ({ scene, step, data })));

export const set = (patch: Partial<PlayerState>) => playerStore.set((s) => ({ ...s, ...patch }));
export const go = (at: number, total: number) => {
  if (at >= total) return set({ phase: "end", playing: false, picked: null, focus: null });
  set({ at: Math.max(0, at), phase: "play", picked: null, focus: null });
};
export const restart = () => set({ phase: "play", at: 0, playing: true, picked: null, focus: null });

/** Rough speaking time until real audio drives pacing (M5): about 2.6 words a second, never under 5 s. */
export const duration = (say: string) => Math.max(5000, (say.split(/\s+/).length / 2.6) * 1000 + 900);

/** The canvas plays the current step through the shared scene store, like an Ask Docent answer. */
export function syncScene(e: Episode | null, s: PlayerState) {
  if (!e || s.phase !== "play") return sceneStore.set(null);
  const links = new Map(e.links.map((l) => [l.id, l]));
  const steps: SceneStep[] = flatten(e).map(({ data }) => ({
    nodes: data.boxes,
    edges: data.links.flatMap((id) => (links.has(id) ? [{ from: links.get(id)!.from, to: links.get(id)!.to }] : [])),
    caption: data.caption,
    packets: data.packets.map((p) => ({ edge: p.link, label: p.label, back: p.back, bad: p.bad })),
  }));
  const cur = sceneStore.get();
  if (cur && cur.steps.length === steps.length && cur.index === s.at && cur.steps[0]?.caption === steps[0]?.caption) return;
  sceneStore.set({ steps, index: s.at });
}

/** Whether the narrator speaks (when a voice is configured). Remembered in this browser. */
const VOICE_KEY = "docent:voice";
function savedVoice(): boolean {
  try {
    return localStorage.getItem(VOICE_KEY) !== "off";
  } catch {
    return true;
  }
}
export const voiceStore = createStore<boolean>(savedVoice());
voiceStore.subscribe(() => {
  try {
    localStorage.setItem(VOICE_KEY, voiceStore.get() ? "on" : "off");
  } catch {
    /* storage off */
  }
});
