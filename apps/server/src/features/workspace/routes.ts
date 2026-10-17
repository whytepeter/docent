import { Hono } from "hono";
import type { Workspace as WorkspaceState } from "@docent/contracts";
import { findDropped, pickFolder, type Workspace } from "./service.ts";

export function workspaceRoutes(ws: Workspace): Hono {
  return new Hono()
    .get("/workspace", (c) => c.json<WorkspaceState>(ws.state()))
    .post("/workspace/open", async (c) => {
      const { path } = (await c.req.json().catch(() => ({}))) as { path?: string };
      if (!path?.trim()) return c.json({ error: "Choose a folder first" }, 400);
      return c.json<WorkspaceState>(ws.open(path));
    })
    .post("/workspace/find", async (c) => {
      const { name, children } = (await c.req.json().catch(() => ({}))) as { name?: string; children?: string[] };
      if (!name?.trim() || name.includes("/")) return c.json({ error: "Drop a folder" }, 400);
      const names = (Array.isArray(children) ? children : []).filter((n) => typeof n === "string" && n && !n.includes("/") && n !== "..").slice(0, 12);
      return c.json({ paths: await findDropped(name.trim(), names) });
    })
    .post("/workspace/pick", async (c) => c.json({ path: await pickFolder() }));
}
