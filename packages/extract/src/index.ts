import { basename, resolve } from "node:path";
import { git, isGitRepo, listFiles } from "./repo.ts";
import { readDocs, readHistory, readStackAndEntries, scanSource } from "./signals.ts";
import { buildGraph, loadProject } from "./ts-graph.ts";
import type { Facts } from "./types.ts";

export type * from "./types.ts";
export { connections, findSymbols } from "./query.ts";
export { loadCachedFacts, repoCacheDir, saveFacts } from "./cache.ts";
export { git } from "./repo.ts";

const TS_LANGS = new Set(["ts", "tsx", "js", "jsx"]);

export interface ExtractOptions {
  onStage?: (stage: string) => void;
}

/** Stage 1: read the repo, never write to it, and return the fact set. */
export function extract(repoPath: string, { onStage = () => {} }: ExtractOptions = {}): Facts {
  const root = resolve(repoPath);
  if (!isGitRepo(root)) throw new Error(`Not a git repository: ${root}`);

  onStage("listing files");
  const files = listFiles(root);
  const warnings: string[] = [];
  const unsupported = files.filter((f) => f.lang && !TS_LANGS.has(f.lang) && (f.kind === "source" || f.kind === "test"));
  if (unsupported.length) {
    const langs = [...new Set(unsupported.map((f) => f.lang))].join(", ");
    warnings.push(`${unsupported.length} files in ${langs} are listed but not parsed yet; their links are missing from the graph.`);
  }

  onStage("building the call graph");
  const codeFiles = files.filter((f) => f.lang && TS_LANGS.has(f.lang) && f.kind !== "config").map((f) => f.path);
  const project = loadProject(root, codeFiles);
  const graph = buildGraph(project, root);
  warnings.push(...graph.warnings);

  onStage("reading history");
  const history = readHistory(root, new Set(files.map((f) => f.path)));

  onStage("indexing docs and signals");
  const docs = readDocs(root, files, graph.symbols);
  const { env, markers } = scanSource(root, files);
  const { stack, entries } = readStackAndEntries(root, files);

  const externals = new Map<string, Set<string>>();
  for (const imp of graph.imports) {
    if (imp.external) externals.set(imp.external, (externals.get(imp.external) ?? new Set()).add(imp.from));
  }

  const imported = new Set(graph.imports.map((i) => i.to).filter(Boolean));
  const entryFiles = new Set(entries.map((e) => e.file));
  const unreferenced = files
    .filter((f) => f.kind === "source" && !imported.has(f.path) && !entryFiles.has(f.path) && !f.path.endsWith(".d.ts"))
    .map((f) => ({ file: f.path, reason: "no file imports it and it is not an entry point", confidence: "inferred" as const }));

  let head: string | null = null;
  let dirty = false;
  try {
    head = git(root, ["rev-parse", "--short", "HEAD"]).trim();
    dirty = git(root, ["status", "--porcelain"]).trim().length > 0;
  } catch {
    warnings.push("No commits yet; history signals are empty.");
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
    warnings,
  };
}
