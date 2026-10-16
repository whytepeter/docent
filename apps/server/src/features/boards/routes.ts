import { Hono } from "hono";
import { loadBoard } from "@docent/analyze";
import type { BoardState, FlowsState, VoiceClip } from "@docent/contracts";
import { pickVoice, speak } from "@docent/voice";
import type { BoardService } from "./service.ts";

export function boardRoutes(svc: BoardService, root: () => string): Hono {
  return new Hono()
    .get("/flows", (c) => c.json<FlowsState>(svc.flows()))
    .post("/flows/propose", (c) => c.json(svc.proposeFlows()))
    .post("/overview/write", (c) => c.json(svc.writeOverview()))
    .get("/boards/:id", (c) => {
      const b = svc.board(c.req.param("id"));
      return b ? c.json<BoardState>(b) : c.json({ error: "No such flow" }, 404);
    })
    .post("/boards/:id/write", (c) => c.json(svc.writeBoard(c.req.param("id"))))
    .post("/boards/:id/stop", (c) => c.json(svc.stopBoard(c.req.param("id"))))
    // Only a tour step's own narration is ever sent to the voice provider, looked up here by its number.
    .post("/boards/:id/voice", async (c) => {
      const { at } = (await c.req.json().catch(() => ({}))) as { at?: number };
      const step = loadBoard(root(), c.req.param("id"))?.steps[at ?? -1];
      if (!step) return c.json({ error: "No such step" }, 404);
      const v = pickVoice();
      if ("reason" in v) return c.json({ error: v.reason }, 409);
      const tone = v.expressive ? (/\?\s*$/.test(step.text) ? "curious" : "calm") : undefined;
      const clip = await speak(v.adapter, v.voice, step.text, { speed: v.speed, ...(tone ? { tone } : {}), signal: c.req.raw.signal });
      return c.json<VoiceClip>({ ...clip, url: `/api/voice/${clip.hash}.wav` });
    });
}
