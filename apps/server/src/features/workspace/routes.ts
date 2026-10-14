import { Hono } from "hono";
import type { Workspace as WorkspaceState } from "@docent/contracts";
import { pickFolder, type Workspace } from "./service.ts";

export function workspaceRoutes(ws: Workspace): Hono {
  return new Hono()
    .get("/workspace", (c) => c.json<WorkspaceState>(ws.state()))
    .post("/workspace/open", async (c) => {
      const { path } = (await c.req.json().catch(() => ({}))) as { path?: string };
      if (!path?.trim()) return c.json({ error: "Choose a folder first" }, 400);
      return c.json<WorkspaceState>(ws.open(path));
    })
    .post("/workspace/pick", async (c) => c.json({ path: await pickFolder() }));
}
