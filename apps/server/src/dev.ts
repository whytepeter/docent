// Development: API only on :4477; Vite serves the app on :5173 and proxies /api here.
// DOCENT_REPO or a path opens that codebase; otherwise the most recent one, so a restart
// lands where you were. With nothing recent, the app asks.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index.ts";

function mostRecent(): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(homedir(), ".docent", "recent.json"), "utf8")) as { root: string }[])[0]?.root;
  } catch {
    return undefined;
  }
}

const repo = process.env.DOCENT_REPO ?? process.argv[2] ?? mostRecent();
const { url } = await startServer({ repo, serveWeb: false, log: (s) => console.log(`  ${s}…`) });
console.log(`docent api on ${url}${repo ? ` · ${repo}` : ""}`);
