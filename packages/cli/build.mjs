// Builds the npm package: the CLI, the server and Docent's own packages in one file (dist/docent.js),
// and the built web app beside it (dist/web). npm packages stay imports, and each must be a dependency
// in package.json, or the build fails.
import { builtinModules } from "node:module";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const web = join(here, "../../apps/web/dist");
if (!existsSync(join(web, "index.html"))) throw new Error("Build the web app first: pnpm --filter @docent/web build");

rmSync(join(here, "dist"), { recursive: true, force: true });
const bare = (path) => (path.startsWith("@") ? path.split("/").slice(0, 2) : path.split("/").slice(0, 1)).join("/");
const imported = new Set();
const npmImports = {
  name: "npm-imports",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@docent/") || args.path.startsWith("node:") || builtinModules.includes(args.path)) return undefined;
      imported.add(bare(args.path));
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: [join(here, "src/index.ts")],
  outfile: join(here, "dist/docent.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [npmImports],
  // Keeps `#!/usr/bin/env node` from the entry; tests are left out because nothing imports them.
  logLevel: "warning",
});

// The voice runtime is fetched with the local voice's weights (see packages/voice/src/kokoro.ts).
const LATER = new Set(["onnxruntime-node", "phonemizer"]);
const missing = [...imported].filter((name) => !LATER.has(name) && !pkg.dependencies?.[name]);
if (missing.length) throw new Error(`Add to packages/cli/package.json dependencies: ${missing.join(", ")}`);

cpSync(web, join(here, "dist/web"), { recursive: true });
// npm shows the package's own README; the repo's is the one to keep up to date.
for (const file of ["README.md", "LICENSE"]) cpSync(join(here, "../..", file), join(here, file));
console.log(`built dist/docent.js and dist/web (imports ${[...imported].sort().join(", ")})`);
