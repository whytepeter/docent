import { basename, resolve } from "node:path";
import { git, isGitRepo, listFiles } from "./repo.ts";
import { findDuplicates } from "./duplicates.ts";
import { readDocs, readHistory, readStackAndEntries, scanSource } from "./signals.ts";
import { buildGoGraph } from "./go-graph.ts";
import { buildPythonGraph } from "./py-graph.ts";
import { parsers } from "./trees.ts";
import { buildGraph, loadProject, type Graph } from "./ts-graph.ts";
import type { Facts } from "./types.ts";

export type * from "./types.ts";
export { connections, findSymbols } from "./query.ts";
export { loadCachedFacts, repoCacheDir, saveFacts } from "./cache.ts";
export { git, isGitRepo, listPaths } from "./repo.ts";
export { findDuplicates } from "./duplicates.ts";

const TS_LANGS = new Set(["ts", "tsx", "js", "jsx", "vue", "svelte"]);
/** Languages with a call graph: the TypeScript compiler's, or tree-sitter's. */
const GRAPH_LANGS = new Set([...TS_LANGS, "python", "go"]);

export interface ExtractOptions {
  onStage?: (stage: string) => void;
}

/** Stage 1: read the repo, never write to it, and return the fact set. */
export async function extract(repoPath: string, { onStage = () => {} }: ExtractOptions = {}): Promise<Facts> {
  const root = resolve(repoPath);
  const hasGit = isGitRepo(root);

  onStage("listing files");
  const files = listFiles(root);
  const warnings: string[] = [];
  const unsupported = files.filter((f) => f.lang && !GRAPH_LANGS.has(f.lang) && (f.kind === "source" || f.kind === "test"));
  if (unsupported.length) {
    const langs = [...new Set(unsupported.map((f) => f.lang))].join(", ");
    warnings.push(`${unsupported.length} files in ${langs} are listed but not parsed yet; their links are missing from the graph.`);
  }

  onStage("building the call graph");
  const code = (langs: Set<string>) => files.filter((f) => f.lang && langs.has(f.lang) && f.kind !== "config").map((f) => f.path);
  const tsFiles = code(TS_LANGS);
  const pyFiles = code(new Set(["python"]));
  const goFiles = code(new Set(["go"]));
  const graphs: Graph[] = [];
  if (tsFiles.length || (!pyFiles.length && !goFiles.length)) graphs.push(buildGraph(loadProject(root, tsFiles), root));
  if (pyFiles.length || goFiles.length) {
    const parser = await parsers();
    if (pyFiles.length) graphs.push(buildPythonGraph(root, pyFiles, parser.python));
    if (goFiles.length) graphs.push(buildGoGraph(root, goFiles, parser.go));
  }
  const graph: Graph = {
    symbols: graphs.flatMap((g) => g.symbols), edges: graphs.flatMap((g) => g.edges), imports: graphs.flatMap((g) => g.imports),
    tests: graphs.flatMap((g) => g.tests), warnings: graphs.flatMap((g) => g.warnings),
  };
  warnings.push(...graph.warnings);

  onStage("reading history");
  const history = readHistory(root, new Set(files.map((f) => f.path)));

  onStage("indexing docs and signals");
  const docs = readDocs(root, files, graph.symbols);
  const { env, markers } = scanSource(root, files);
  const { stack, entries } = readStackAndEntries(root, files);
  const duplicates = findDuplicates(root, files, graph.symbols);

  const externals = new Map<string, Set<string>>();
  for (const imp of graph.imports) {
    if (imp.external) externals.set(imp.external, (externals.get(imp.external) ?? new Set()).add(imp.from));
  }

  const imported = new Set(graph.imports.map((i) => i.to).filter((p): p is string => !!p));
  // Components a template renders without importing them (auto-imports) are used too.
  for (const e of graph.edges) if (e.kind === "renders" && e.file !== e.to.split("#")[0]) imported.add(e.to.split("#")[0]!);
  const entryFiles = new Set(entries.map((e) => e.file));
  // A Go package is its folder: every file in a folder that is imported, or holds an entry point, is in use.
  const goDirs = new Set([...imported, ...entryFiles].filter((p) => p.endsWith(".go")).map((p) => p.slice(0, p.lastIndexOf("/") + 1)));
  for (const f of files) if (f.lang === "go" && goDirs.has(f.path.slice(0, f.path.lastIndexOf("/") + 1))) imported.add(f.path);
  const unreferenced = files
    .filter((f) => f.kind === "source" && !imported.has(f.path) && !entryFiles.has(f.path) && !f.path.endsWith(".d.ts") && GRAPH_LANGS.has(f.lang ?? "") && !/(^|\/)(__init__|__main__|conftest|setup|manage)\.py$|(^|\/)migrations\//.test(f.path))
    .map((f) => ({ file: f.path, reason: "no file imports it and it is not an entry point", confidence: "inferred" as const }));

  let head: string | null = null;
  let dirty = false;
  try {
    head = git(root, ["rev-parse", "--short", "HEAD"]).trim();
    dirty = git(root, ["status", "--porcelain"]).trim().length > 0;
  } catch {
    warnings.push(hasGit ? "No commits yet; history signals are empty." : "No git history (this folder isn't a git repository), so there are no commit messages to explain why code changed and no files that usually change together.");
  }

  return {
    version: 1,
    repo: { root, name: basename(root), head, dirty, extractedAt: new Date().toISOString() },
    stack,
    files,
    symbols: graph.symbols,
    edges: graph.edges,
    imports: graph.imports,
    tests: graph.tests,
    entries,
    commits: history.commits,
    cochange: history.cochange,
    docs,
    env,
    externals: [...externals].map(([name, set]) => ({ name, files: [...set].sort() })).sort((a, b) => b.files.length - a.files.length),
    markers,
    unreferenced,
    duplicates,
    warnings,
  };
}
