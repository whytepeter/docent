/**
 * The fact set: everything Docent knows about a repo before any LLM explains it.
 * Every link carries a confidence. Nothing here is narrated; it is read from the code.
 */

export type Confidence = "confirmed" | "inferred" | "unknown";

export interface LineRange {
  start: number;
  end: number;
}

export type FileKind = "source" | "test" | "doc" | "agent" | "config" | "generated" | "other";

export interface FileFact {
  path: string;
  kind: FileKind;
  lang: string | null;
  lines: number;
  /** Content hash; drives incremental re-runs later. */
  hash: string;
}

export type SymbolKind = "function" | "component" | "method" | "class" | "interface" | "type" | "const";

export interface SymbolFact {
  /** `path#Outer.inner` — stable across runs while names and files stay put. */
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  range: LineRange;
  exported: boolean;
  /** Enclosing symbol for nested functions (a handler inside a component). */
  parent: string | null;
}

export type EdgeKind = "calls" | "renders" | "constructs";

export interface EdgeFact {
  /** A symbol id, a test id (`path#test:name`), or `path#<module>` for top-level code. */
  from: string;
  /** A symbol id. For calls through an interface with no traced implementation, `path#Type.member`. */
  to: string;
  kind: EdgeKind;
  file: string;
  line: number;
  confidence: Confidence;
  /** How the target was reached when it isn't a direct reference, e.g. "interface member". */
  via?: string;
}

export interface ImportFact {
  from: string;
  /** Repo-relative target file, or null for packages and unresolved specifiers. */
  to: string | null;
  specifier: string;
  names: string[];
  line: number;
  kind: "static" | "type" | "dynamic" | "reexport";
  external: string | null;
  confidence: Confidence;
}

export interface TestFact {
  /** `path#test:Suite > name` */
  id: string;
  name: string;
  suite: string[];
  file: string;
  range: LineRange;
}

export interface EntryFact {
  kind: string;
  file: string;
  detail: string;
  confidence: Confidence;
}

export interface CommitFact {
  sha: string;
  date: string;
  subject: string;
  body: string;
  files: string[];
}

export interface DocMention {
  text: string;
  line: number;
  /** A file path or symbol id the mention resolves to. */
  target: string | null;
  /** The mention looks like a repo path or a code name, but nothing in the code matches. A likely stale doc. */
  missing?: boolean;
  /** What kind of thing is missing: a file path, or a name the code once declared and no longer contains. */
  missingKind?: "path" | "name";
  /** For a missing name: the commit that removed its declaration. Evidence of when and how it went away. */
  removedIn?: { sha: string; subject: string };
}

export interface DuplicateFact {
  /** "exact": same body ignoring comments and spacing. "shape": same body with names and literals renamed. */
  kind: "exact" | "shape";
  confidence: Confidence;
  /** Length of the shortest copy. */
  lines: number;
  members: { symbol: string; file: string; start: number; end: number }[];
}

export interface DocFact {
  path: string;
  kind: "doc" | "agent";
  headings: { text: string; line: number }[];
  mentions: DocMention[];
}

export interface Facts {
  version: 1;
  repo: {
    root: string;
    name: string;
    head: string | null;
    dirty: boolean;
    extractedAt: string;
  };
  stack: string[];
  files: FileFact[];
  symbols: SymbolFact[];
  edges: EdgeFact[];
  imports: ImportFact[];
  tests: TestFact[];
  entries: EntryFact[];
  commits: CommitFact[];
  cochange: Record<string, { file: string; count: number }[]>;
  docs: DocFact[];
  env: { name: string; file: string; line: number }[];
  externals: { name: string; files: string[] }[];
  markers: { kind: string; file: string; line: number; text: string }[];
  unreferenced: { file: string; reason: string; confidence: Confidence }[];
  /** Copy-pasted functions across files. Older cached facts may not have it. */
  duplicates?: DuplicateFact[];
  warnings: string[];
}
