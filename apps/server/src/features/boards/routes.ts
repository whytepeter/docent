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
    // Only the cards whose code changed are rewritten; the rest of the tour stays word for word.
    .post("/boards/:id/update", (c) => c.json(svc.writeBoard(c.req.param("id"), "update")))
    .post("/boards/:id/stop", (c) => c.json(svc.stopBoard(c.req.param("id"))))
    // Only a tour beat's own words are ever sent to the voice provider, looked up here by step and beat.
    .post("/boards/:id/voice", async (c) => {
      const { at, beat } = (await c.req.json().catch(() => ({}))) as { at?: number; beat?: number };
      const said = loadBoard(root(), c.req.param("id"))?.steps[at ?? -1]?.beats[beat ?? 0];
      if (!said?.text) return c.json({ error: "No such beat" }, 404);
      const v = pickVoice();
      if ("reason" in v) return c.json({ error: v.reason }, 409);
      const tone = v.expressive ? said.tone : undefined;
      const clip = await speak(v.adapter, v.voice, said.text, { speed: v.speed, ...(tone ? { tone } : {}), signal: c.req.raw.signal });
      return c.json<VoiceClip>({ ...clip, url: `/api/voice/${clip.hash}.wav` });
    });
}
