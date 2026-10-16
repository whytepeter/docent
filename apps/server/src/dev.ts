// Development: API only on :4477; Vite serves the app on :5173 and proxies /api here.
// DOCENT_REPO or a path opens that codebase; otherwise the most recent one, so a restart
// lands where you were. With nothing recent, the app asks.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./index.ts";

// Keys (CARTESIA_API_KEY, ANTHROPIC_API_KEY…) from Docent's own .env, if there is one.
const envFile = join(dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function mostRecent(): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(homedir(), ".docent", "recent.json"), "utf8")) as { root: string }[])[0]?.root;
  } catch {
    return undefined;
  }
}

const repo = process.env.DOCENT_REPO ?? process.argv[2] ?? mostRecent();
// DOCENT_PORT runs a second copy beside one already on 4477 (e.g. to test while using Docent).
const port = Number(process.env.DOCENT_PORT) || 4477;
const { url } = await startServer({ repo, port, serveWeb: false, log: (s) => console.log(`  ${s}…`) });
console.log(`docent api on ${url}${repo ? ` · ${repo}` : ""}`);
