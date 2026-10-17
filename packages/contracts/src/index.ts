/**
 * The API between the local server and the app. Both sides import these types;
 * nothing else crosses the boundary.
 */
import type { Confidence, EdgeKind, FileFact, SymbolKind } from "@docent/extract";
import type { Board, Episode, Feature, FeatureAnalysis, FeatureMap, Flow, FlowList, ProjectOverview } from "@docent/analyze";

export type { Board, Episode, Feature, FeatureAnalysis, FeatureMap, Flow, FlowList, ProjectOverview };

/** The flows Docent proposed for this codebase, and the job proposing them. */
export interface FlowsState {
  flows: FlowList | null;
  job: Job | null;
  /** Flows whose board is already written. */
  ready: string[];
  /** What the project does, shown above the flows. */
  overview: ProjectOverview | null;
  overviewJob: Job | null;
  /** Boards being drawn now, or finished in the last few minutes, so leaving a board never hides its progress. */
  drawing: { id: string; title: string; job: Job }[];
}

/** One flow's board (once written) and the job writing or checking it. */
export interface BoardState {
  flow: Flow;
  board: Board | null;
  job: Job | null;
}

/** An episode and whether the feature's code changed since it was written. */
export interface EpisodeState {
  feature: Feature;
  episode: Episode | null;
  verified: boolean;
  stale: boolean;
}

export type { Confidence, EdgeKind, SymbolKind };

/** Hash routes the app understands. */
export type Route =
  | { view: "system" }
  | { view: "feature"; id: string }
  | { view: "review" }
  | { view: "area"; id: string }
  | { view: "file"; path: string }
  | { view: "fn"; id: string }
  | { view: "episode"; id: string }
  | { view: "board"; id: string; step?: number; card?: string };

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
  /** Doc mentions of a file path, or a name the code once declared, that no longer exist. */
  missingPaths: { doc: string; line: number; text: string; kind: "doc" | "agent"; missingKind: "path" | "name"; removedIn?: { sha: string; subject: string } }[];
  unreferenced: { file: string; reason: string }[];
  inferred: { from: string; to: string; file: string; line: number; via?: string }[];
  /** Functions copied across files: "exact" (confirmed) or the same code with names changed (inferred). */
  duplicates: { kind: "exact" | "shape"; confidence: "confirmed" | "inferred" | "unknown"; lines: number; members: { symbol: string; file: string; start: number; end: number }[] }[];
}

/** What the feature verifications found, gathered across features for the health report. */
export interface AnalysisHealth {
  issues: { featureId: string; feature: string; title: string; detail: string; severity: "high" | "medium" | "low"; at: { file: string; start: number; end: number } | null }[];
  /** Claims where a doc and the code disagree, found by reading both. */
  docMismatches: { featureId: string; feature: string; text: string; label: string; at: { file: string; start: number; end: number } | null }[];
  /** Claims the citation check or the second reader took back: shown so nobody relies on them. */
  disputed: { featureId: string; feature: string; text: string; claimedLabel: string; label: string; note: string }[];
  /** Features whose code changed since they were verified. */
  stale: { featureId: string; feature: string }[];
}

/** A question asked from a view, with what the canvas shows. */
export interface AskRequest {
  route: Route;
  question: string;
  boxes: { id: string; title: string; sub?: string }[];
  links: { from: string; to: string; label?: string }[];
  history: { question: string; answer: string }[];
}

export type AskClaim = FeatureAnalysis["claims"][number];

export interface AskAnswer {
  paragraphs: AskClaim[];
  scene: { nodes: string[]; edges: { from: string; to: string }[]; caption: string }[];
  model: string;
}

/** Streamed while an answer is made: what Docent is doing, then the answer or an error. */
export type AskEvent =
  | { type: "stage"; stage: "reading" | "answering" | "checking" }
  /** The answer once the citation check has passed, shown while the second reader settles its labels. */
  | { type: "draft"; answer: AskAnswer }
  /** cachedAt: this exact question was answered before, for the same board and code; it's served from disk. */
  | { type: "answer"; answer: AskAnswer; cachedAt?: string }
  | { type: "error"; error: string };

/** A question asked on a board earlier, with its checked answer: the board's conversation after a reload. */
export interface AskedBefore {
  question: string;
  answer: AskAnswer;
  at: string;
}

/** A voice to choose from in Settings. */
export interface VoiceOption {
  id: string;
  name: string;
  description?: string;
  own: boolean;
}

export type VoiceProvider = "cartesia" | "fish-audio";

/** Everything the Settings panel shows. Keys come back only as masked hints. */
export interface Settings {
  voice: {
    provider: VoiceProvider;
    voices: Partial<Record<VoiceProvider, string>>;
    speed: number;
    expressive: boolean;
    keys: Record<VoiceProvider, string | null>;
    /** Your own entries (term → how to say it); `defaults` apply underneath. */
    pronunciations: Record<string, string>;
    defaults: Record<string, string>;
  };
  claude: { mode: "claude-code" | "api"; describe: string; apiKey: string | null };
}

/** Whether narration can be heard, and if not, why. */
export type VoiceStatus = { available: true; provider: string } | { available: false; reason: string };

/** One spoken line: where to fetch it and when each word is said (seconds). */
export interface VoiceClip {
  hash: string;
  url: string;
  durationMs: number;
  words: { word: string; start: number; end: number }[];
}

/** Where a codebase came from: a folder on this machine, a GitHub clone Docent made, or a zip it unpacked. */
export type RepoSource =
  | { kind: "folder" }
  | { kind: "github"; /** owner/repo */ repo: string; url: string; branch?: string }
  | { kind: "zip"; file: string };

export interface RecentRepo {
  root: string;
  name: string;
  openedAt: string;
  source?: RepoSource;
}

/** Which codebase the app is showing, and the ones opened before. */
export interface Workspace {
  current: { root: string; name: string; source?: RepoSource } | null;
  recent: RecentRepo[];
}

/** A GitHub clone or pull running on the server, polled by the welcome page. */
export interface CloneJob {
  id: string;
  /** owner/repo */
  repo: string;
  action: "clone" | "pull";
  /** What git is doing, in its words ("Receiving objects"). */
  stage: string;
  /** 0 to 100 over the whole clone, or null before git reports any. */
  percent: number | null;
  done: boolean;
  error: string | null;
  /** The checkout to open once done. */
  path: string | null;
}

/** Asking for a GitHub repo: Docent already has a checkout of it, or it started cloning one. */
export type GithubStart = { status: "exists"; repo: string; path: string } | { status: "cloning"; job: CloneJob };

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
    case "episode": return `#/episode/${encodeURIComponent(route.id)}`;
    case "board": return `#/board/${encodeURIComponent(route.id)}`;
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
  if (view === "episode" && value) return { view: "episode", id: value };
  return { view: "system" };
};

/** A background job (discovery or verification) and how far it got. */
export interface Job {
  kind: "discover" | "verify" | "episode" | "prepare" | "flows" | "board" | "overview";
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: string[];
  failed: { id: string; error: string }[];
  message: string;
  error?: string;
  cancelled?: boolean;
  /** What's happening right now, in plain words. */
  stage?: string;
  /** Names of the features being worked on at this moment. */
  active?: string[];
  /** How long the whole job should take, in seconds from `startedAt`; refined as work finishes. */
  estimateSeconds?: number;
  /** The feature an episode job is for. */
  featureId?: string;
}

/** Which features a file or function belongs to, and the flow steps that pass through it. */
export interface PartOf {
  features: {
    id: string;
    name: string;
    kind: Feature["kind"];
    /** Flow steps (from the feature's verification) that land in this file or function. */
    steps: { index: number; step: string }[];
  }[];
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
  /** Episode writing runs on its own lane, alongside the job above. */
  episodeJob: Job | null;
  provider: string;
  /** A feature depends on another when one of its files imports one of the other's. */
  links: { from: string; to: string; count: number }[];
}

export interface FeatureDetail {
  feature: Feature;
  analysis: FeatureAnalysis | null;
  stale: boolean;
}
