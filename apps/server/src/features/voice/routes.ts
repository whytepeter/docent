import { Hono } from "hono";
import { loadEpisode, narrationLine } from "@docent/analyze";
import type { VoiceClip } from "@docent/contracts";
import { pickVoice, speak } from "@docent/voice";

/**
 * Narration audio for episodes. A clip is asked for by episode and step, and the server looks up the
 * narration itself, so only narration text ever reaches the voice provider (never code, never a free string).
 */
export function voiceRoutes(root: () => string): Hono {
  return new Hono()
    .post("/episodes/:id/voice", async (c) => {
      const { at } = (await c.req.json().catch(() => ({}))) as { at?: number };
      const episode = loadEpisode(root(), c.req.param("id"));
      const line = episode ? narrationLine(episode, at ?? -1) : null;
      if (!line) return c.json({ error: "No such step" }, 404);
      const v = pickVoice();
      if ("reason" in v) return c.json({ error: v.reason }, 409);
      const clip = await speak(v.adapter, v.voice, line.text, { speed: v.speed, ...(v.expressive ? { tone: line.tone } : {}), signal: c.req.raw.signal });
      return c.json<VoiceClip>({ ...clip, url: `/api/voice/${clip.hash}.wav` });
    });
}
