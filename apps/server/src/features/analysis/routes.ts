import { Hono } from "hono";
import type { Feature } from "@docent/analyze";
import type { AnalysisService } from "./service.ts";

export function analysisRoutes(svc: AnalysisService): Hono {
  return new Hono()
    .get("/features", (c) => c.json(svc.state()))
    .get("/episodes/:id", (c) => {
      const e = svc.episode(c.req.param("id"));
      return e ? c.json(e) : c.json({ error: "No such feature" }, 404);
    })
    .post("/episodes/:id/write", (c) => c.json(svc.startEpisode(c.req.param("id"))))
    .get("/features/health", (c) => c.json(svc.health()))
    .get("/part-of", (c) => c.json(svc.partOf(c.req.query("file") ?? "", c.req.query("symbol") || undefined)))
    .get("/features/:id", (c) => {
      const d = svc.detail(c.req.param("id"));
      return d ? c.json(d) : c.json({ error: "No such feature" }, 404);
    })
    .post("/features/cancel", (c) => c.json(svc.cancel()))
    .post("/features/discover", (c) => c.json(svc.startDiscovery()))
    .post("/features/prepare", (c) => c.json(svc.startPrepare()))
    .post("/features/verify", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { id?: string };
      return c.json(svc.startVerify(body.id));
    })
    .put("/features", async (c) => {
      const body = (await c.req.json()) as { features: Feature[]; approve?: boolean };
      return c.json(svc.saveEdits(body));
    });
}
