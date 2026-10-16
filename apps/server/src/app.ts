import { existsSync } from "node:fs";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { AnalysisService, analysisRoutes } from "./features/analysis/index.ts";
import { askRoutes } from "./features/ask/index.ts";
import { BoardService, boardRoutes } from "./features/boards/index.ts";
import { GraphIndex, graphRoutes } from "./features/graph/index.ts";
import { RepoService, repoRoutes } from "./features/repo/index.ts";
import { sourceRoutes } from "./features/source/index.ts";
import { settingsRoutes } from "./features/settings/index.ts";
import { voiceRoutes } from "./features/voice/index.ts";
import { Workspace, workspaceRoutes } from "./features/workspace/index.ts";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Every route that reads one repo, built fresh each time a folder is opened. */
function repoApp(repo: RepoService): Hono {
  let index = new GraphIndex(repo.facts);
  repo.onChange(() => {
    index = new GraphIndex(repo.facts);
  });
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, 500));
  app.route("/api", repoRoutes(repo));
  app.route("/api", graphRoutes(() => index));
  app.route("/api", sourceRoutes(repo.root, () => repo.facts));
  app.route("/api", analysisRoutes(new AnalysisService(repo)));
  app.route("/api", askRoutes(repo, () => index));
  app.route("/api", voiceRoutes(() => repo.root));
  app.route("/api", boardRoutes(new BoardService(repo), () => repo.root));
  return app;
}

export function createApp(webDist: string | null, log: (line: string) => void = () => {}): { app: Hono; workspace: Workspace } {
  const workspace = new Workspace(repoApp, log);
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, 500));

  // The API serves source code and can start Claude runs, so only this machine's pages may use it:
  // the Host must be local (stops DNS rebinding), and anything that changes state needs a header
  // a cross-site form or fetch can't send without a CORS preflight (stops CSRF).
  app.use("/api/*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (!LOCAL_HOSTS.has(host)) return c.json({ error: "Docent only answers pages on this machine" }, 403);
    if (c.req.method !== "GET" && c.req.header("x-docent") !== "1") return c.json({ error: "Missing the x-docent header" }, 403);
    await next();
  });

  app.route("/api", workspaceRoutes(workspace));
  app.route("/api", settingsRoutes());
  app.all("/api/*", (c) => (workspace.app ? workspace.app.fetch(c.req.raw) : c.json({ error: "No codebase is open" }, 409)));

  if (webDist && existsSync(webDist)) {
    app.use("/*", serveStatic({ root: webDist }));
    app.get("*", serveStatic({ root: webDist, path: "index.html" }));
  }
  return { app, workspace };
}
