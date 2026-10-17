import { Hono } from "hono";
import type { CloneJob, GithubStart, Workspace as WorkspaceState } from "@docent/contracts";
import { cloneJob, parseGithub, pullGithub, startGithub } from "./github.ts";
import { findDropped, MAX_ZIP_BYTES, pickFolder, type Workspace } from "./service.ts";

const NOT_GITHUB = "That doesn’t look like a GitHub repo. Paste a URL like https://github.com/owner/repo, or just owner/repo.";

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
    .post("/workspace/pick", async (c) => c.json({ path: await pickFolder() }))
    // Clone a GitHub repo into ~/.docent/checkouts, or find the copy Docent already has.
    .post("/workspace/github", async (c) => {
      const { url } = (await c.req.json().catch(() => ({}))) as { url?: string };
      const ref = parseGithub(url ?? "");
      if (!ref) return c.json({ error: NOT_GITHUB }, 400);
      return c.json<GithubStart>(startGithub(ref));
    })
    .post("/workspace/github/pull", async (c) => {
      const { url } = (await c.req.json().catch(() => ({}))) as { url?: string };
      const ref = parseGithub(url ?? "");
      if (!ref) return c.json({ error: NOT_GITHUB }, 400);
      return c.json<CloneJob>(pullGithub(ref));
    })
    .get("/workspace/jobs/:id", (c) => {
      const job = cloneJob(c.req.param("id"));
      return job ? c.json<CloneJob>(job) : c.json({ error: "That clone isn’t running any more" }, 404);
    })
    // The zip's bytes as the body, its file name in ?name=.
    .post("/workspace/zip", async (c) => {
      const name = c.req.query("name") ?? "project.zip";
      if (Number(c.req.header("content-length") ?? 0) > MAX_ZIP_BYTES) return c.json({ error: `That zip is over ${MAX_ZIP_BYTES / 1024 / 1024} MB, the most Docent opens.` }, 413);
      const buf = Buffer.from(await c.req.arrayBuffer());
      if (buf.length > MAX_ZIP_BYTES) return c.json({ error: `That zip is over ${MAX_ZIP_BYTES / 1024 / 1024} MB, the most Docent opens.` }, 413);
      return c.json<WorkspaceState>(ws.importZip(buf, name));
    });
}
