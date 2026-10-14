import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { RepoService } from "./features/repo/index.ts";

export { RepoService };

const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

export interface StartOptions {
  /** A folder to open right away. Without one, the app asks which codebase to open. */
  repo?: string;
  port?: number;
  log?: (line: string) => void;
  /** Serve the built app too. Off in development, where Vite serves it. */
  serveWeb?: boolean;
}

/** Starts the local server on 127.0.0.1 only. Resolves with the URL once it listens. */
export function startServer({ repo, port = 4477, log = () => {}, serveWeb = true }: StartOptions): Promise<{ url: string; close: () => void }> {
  const { app, workspace } = createApp(serveWeb ? WEB_DIST : null, log);
  if (repo) workspace.open(repo);
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
      resolve({ url: `http://127.0.0.1:${info.port}`, close: () => server.close() });
    });
    server.on("error", reject);
  });
}
