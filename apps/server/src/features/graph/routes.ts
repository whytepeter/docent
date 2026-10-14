import { Hono } from "hono";
import type { GraphIndex } from "./index-model.ts";

export function graphRoutes(index: () => GraphIndex): Hono {
  return new Hono()
    .get("/overview", (c) => c.json(index().overview()))
    .get("/tree", (c) => c.json(index().tree()))
    .get("/health", (c) => c.json(index().health()))
    .get("/search", (c) => c.json(index().search(c.req.query("q") ?? "")))
    .get("/area", (c) => {
      const view = index().areaView(c.req.query("id") ?? "");
      return view ? c.json(view) : c.json({ error: "No such area" }, 404);
    })
    .get("/file", (c) => {
      const view = index().fileView(c.req.query("path") ?? "");
      return view ? c.json(view) : c.json({ error: "No such file" }, 404);
    })
    .get("/symbol", (c) => {
      const view = index().symbolView(c.req.query("id") ?? "");
      return view ? c.json(view) : c.json({ error: "No such function" }, 404);
    });
}
