// Development: API only on :4477; Vite serves the app on :5173 and proxies /api here.
import { startServer } from "./index.ts";

// DOCENT_REPO or a path opens that codebase right away; without one, the app asks.
const repo = process.env.DOCENT_REPO ?? process.argv[2];
const { url } = await startServer({ repo, serveWeb: false, log: (s) => console.log(`  ${s}…`) });
console.log(`docent api on ${url}`);
