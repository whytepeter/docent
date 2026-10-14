/**
 * The API between the local server and the app. Both sides import these types;
 * nothing else crosses the boundary.
 */
import type { Confidence, EdgeKind, FileFact, SymbolKind } from "@docent/extract";
import type { Feature, FeatureAnalysis, FeatureMap } from "@docent/analyze";

export type { Feature, FeatureAnalysis, FeatureMap };

export type { Confidence, EdgeKind, SymbolKind };

/** Hash routes the app understands. */
export type Route =
  | { view: "system" }
  | { view: "feature"; id: string }
  | { view: "review" }
  | { view: "area"; id: string }
  | { view: "file"; path: string }
  | { view: "fn"; id: string };

export interface Area {
  id: string;
  label: string;
  /** The folder kind it sits in (`features`, `shared`…), when there is one. */
  group: string | null;
  /** Folder the area covers, e.g. `src/features/document-upload`. */
  path: string;
  files: number;
  functions: number;
  tests: number;
}

export interface AreaLink {
  from: string;
  to: string;
  /** Number of import statements behind the link. */
  count: number;
}

export interface RepoInfo {
  name: string;
  head: string | null;
  dirty: boolean;
  extractedAt: string;
}

export interface Overview {
  repo: RepoInfo;
  stack: string[];
  areas: Area[];
  links: AreaLink[];
  entries: { kind: string; file: string; detail: string }[];
  counts: { files: number; functions: number; components: number; tests: number; commits: number };
}

export interface SymbolRef {
  id: string;
  name: string;
  kind: SymbolKind | "unknown";
  file: string;
  line: number;
  /** Display name including its owner, e.g. `DocumentUpload.handleVerify`. */
  label: string;
}

/** One connection, with every line where it happens. */
export interface Link {
  symbol: SymbolRef;
  kind: EdgeKind;
  /** File the lines belong to (where the call is written). */
  file: string;
  lines: number[];
  confidence: Confidence;
  via?: string;
}

export interface TestRef {
  id: string;
  name: string;
  file: string;
  line: number;
  /** 0 = the test calls it directly, 1 = through one helper. */
  hops: number;
}

export interface CommitRef {
  sha: string;
  date: string;
  subject: string;
  body: string;
}

export interface Mention {
  doc: string;
  line: number;
  text: string;
  kind: "doc" | "agent";
}

export interface SymbolView {
  symbol: SymbolRef & { end: number; exported: boolean };
  area: Area | null;
  parent: SymbolRef | null;
  children: SymbolRef[];
  callers: Link[];
  callees: Link[];
  tests: TestRef[];
  mentions: Mention[];
  history: CommitRef[];
  cochange: { file: string; count: number }[];
}

export interface FileView {
  file: FileFact;
  area: Area | null;
  symbols: SymbolRef[];
  importers: { file: string; line: number; names: string[] }[];
  imports: { file: string | null; external: string | null; names: string[]; line: number; kind: string }[];
  tests: TestRef[];
  mentions: Mention[];
  history: CommitRef[];
  cochange: { file: string; count: number }[];
  unreferenced: boolean;
}

export interface AreaView {
  area: Area;
  files: { path: string; functions: number; tests: number; importers: number; unreferenced: boolean }[];
  /** Imports between files inside the area. */
  links: { from: string; to: string }[];
  inbound: AreaLink[];
  outbound: AreaLink[];
}

export interface TreeNode {
  id: string;
  label: string;
  kind: "area" | "file" | "symbol";
  symbolKind?: SymbolKind;
  /** For areas: the folder group they sit in, shown as a sidebar section. */
  group?: string | null;
  route: Route;
  children?: TreeNode[];
}

export interface SearchHit {
  kind: "area" | "file" | "symbol";
  label: string;
  detail: string;
  symbolKind?: SymbolKind;
  route: Route;
}

export interface Health {
  missingPaths: { doc: string; line: number; text: string; kind: "doc" | "agent" }[];
  unreferenced: { file: string; reason: string }[];
  inferred: { from: string; to: string; file: string; line: number; via?: string }[];
}

export interface RecentRepo {
  root: string;
  name: string;
  openedAt: string;
}

/** Which codebase the app is showing, and the ones opened before. */
export interface Workspace {
  current: { root: string; name: string } | null;
  recent: RecentRepo[];
}

export interface Status {
  /** Commit the facts describe. */
  factsHead: string | null;
  /** Commit the repo is on now. */
  head: string | null;
  /** True when code changed since the facts were read (new commit or edited files). */
  stale: boolean;
  extracting: boolean;
}

export interface SourceSlice {
  path: string;
  lang: string | null;
  /** Line number of `lines[0]`. */
  start: number;
  total: number;
  lines: string[];
}

export const routeToHash = (route: Route): string => {
  switch (route.view) {
    case "system": return "#/";
    case "area": return `#/area/${encodeURIComponent(route.id)}`;
    case "file": return `#/file/${encodeURIComponent(route.path)}`;
    case "fn": return `#/fn/${encodeURIComponent(route.id)}`;
    case "feature": return `#/feature/${encodeURIComponent(route.id)}`;
    case "review": return "#/review";
  }
};

export const hashToRoute = (hash: string): Route => {
  const [, view, ...rest] = hash.replace(/^#/, "").split("/");
  const value = decodeURIComponent(rest.join("/"));
  if (view === "area" && value) return { view: "area", id: value };
  if (view === "file" && value) return { view: "file", path: value };
  if (view === "fn" && value) return { view: "fn", id: value };
  if (view === "feature" && value) return { view: "feature", id: value };
  if (view === "review") return { view: "review" };
  return { view: "system" };
};

/** A background job (discovery or verification) and how far it got. */
export interface Job {
  kind: "discover" | "verify";
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: string[];
  failed: { id: string; error: string }[];
  message: string;
  error?: string;
}

export interface FeatureCard {
  feature: Feature;
  /** Short verification result, when it exists. */
  analysis: { status: FeatureAnalysis["status"]; summary: string; claims: number; confirmed: number; demoted: number; issues: number; stale: boolean } | null;
}

export interface FeaturesState {
  map: FeatureMap | null;
  cards: FeatureCard[];
  job: Job | null;
  provider: string;
  /** A feature depends on another when one of its files imports one of the other's. */
  links: { from: string; to: string; count: number }[];
}

export interface FeatureDetail {
  feature: Feature;
  analysis: FeatureAnalysis | null;
  stale: boolean;
}
