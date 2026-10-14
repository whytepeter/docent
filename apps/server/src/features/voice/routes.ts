import { Hono } from "hono";
import { loadEpisode } from "@docent/analyze";
import type { VoiceClip } from "@docent/contracts";
import { pickVoice, speak, type Tone } from "@docent/voice";

/** Episodes written before tones existed: a question sounds curious, a scene about what goes wrong sounds concerned. */
function inferTone(scene: { title: string; objective: string }, say: string): Tone {
  if (/\?\s*$/.test(say)) return "curious";
  if (/wrong|break|risk|careful|fail|trust/i.test(`${scene.title} ${scene.objective}`)) return "concerned";
  return "calm";
}

/**
 * Narration audio for episodes. A clip is asked for by episode and step, and the server looks up the
 * narration itself, so only narration text ever reaches the voice provider (never code, never a free string).
 */
export function voiceRoutes(root: () => string): Hono {
  return new Hono()
    .post("/episodes/:id/voice", async (c) => {
      const { at } = (await c.req.json().catch(() => ({}))) as { at?: number };
      const episode = loadEpisode(root(), c.req.param("id"));
      const flat = episode?.scenes.flatMap((scene) => scene.steps.map((step) => ({ scene, step }))) ?? [];
      const found = flat[at ?? -1];
      if (!found) return c.json({ error: "No such step" }, 404);
      const v = pickVoice();
      if ("reason" in v) return c.json({ error: v.reason }, 409);
      // A predict step asks its question; any other step says its narration.
      const text = found.step.predict ? found.step.predict.question : found.step.say;
      const tone = v.expressive ? (found.step.predict ? "curious" : found.step.tone ?? inferTone(found.scene, found.step.say)) : undefined;
      const clip = await speak(v.adapter, v.voice, text, { speed: v.speed, ...(tone ? { tone } : {}), signal: c.req.raw.signal });
      return c.json<VoiceClip>({ ...clip, url: `/api/voice/${clip.hash}.wav` });
    });
}
