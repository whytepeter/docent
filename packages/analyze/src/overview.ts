import type { Facts } from "@docent/extract";
import { redact, z, type LlmProvider } from "@docent/llm";
import { Claim } from "./board.ts";
import { makeChecker } from "./citations.ts";
import { discoveryDigest } from "./digest.ts";
import { refuteClaims } from "./refute.ts";
import type { AnalysisClaim } from "./types.ts";

/*
 * The overview: what the project does, readable in a minute, before any flow. One short Claude pass with
 * read-only tools. Every sentence cites the lines it rests on and is checked like a board's claims:
 * the citation check at once, the second reader behind it.
 */

const OverviewSchema = z.object({
  what: Claim.describe("Two plain sentences: what this project is, who uses it, and what they get done with it"),
  how: Claim.describe("One plain sentence on how it's built: what kind of app, the main framework, where its data comes from"),
  parts: z.array(z.object({
    name: z.string().describe("Plain name of the part: 'Screens', 'Session store', 'API client'"),
    path: z.string().describe("The folder or file it lives in, exactly as in the facts, e.g. src/pages"),
    does: Claim.describe("One sentence: what this part is responsible for"),
  })).describe("3 to 6 main parts, in the order a user's action meets them"),
  talksTo: z.array(z.object({
    name: z.string().describe("Plain name of the outside system: 'Verification API', 'File storage', 'Live socket'"),
    does: Claim.describe("One sentence: what the project sends it or gets from it"),
  })).describe("0 to 5 systems outside this repo that the code calls; only ones the code shows"),
});

export interface OverviewPart {
  name: string;
  path: string;
  does: AnalysisClaim;
}

export interface ProjectOverview {
  version: 1;
  generatedAt: string;
  model: string;
  /** "checking" while the second reader runs behind the overview; then "checked". */
  status: "checking" | "checked";
  what: AnalysisClaim;
  how: AnalysisClaim;
  parts: OverviewPart[];
  talksTo: { name: string; does: AnalysisClaim }[];
  notes: string[];
}

const OVERVIEW_SYSTEM = `You are Docent. A developer is opening this codebase for the first time and wants to know, in under a minute, what the project does before they look at any one flow.

Read what you need (you have read-only tools): the manifest, the entry files, the top-level folders. Then say:
- what the project is, who uses it and what they get done, in two plain sentences;
- how it's built, in one sentence;
- its 3 to 6 main parts, in the order a user's action meets them, each with the folder or file it lives in;
- the systems outside this repo it talks to, only the ones the code shows.

Plain words for someone new: no jargon they'd have to look up, no file paths inside sentences. Every sentence carries a label and evidence: file, start line, end line, and mentions (identifiers or short exact snippets in those lines). A script checks them and a second reader tries to refute every confirmed one. "confirmed" = read in the code; "inferred" = a reasoned guess; "unknown" = can't tell from this repo; "record" = a commit says so (give the sha). A README is a hint that may be stale: confirm it in the code, or label the sentence inferred. Use only files that exist.`;

type RawClaim = z.infer<typeof Claim>;
const pending = (c: RawClaim): AnalysisClaim => ({ ...c, kind: "behavior", evidence: c.evidence.map((e) => ({ ...e, check: { ok: false, reason: "not checked yet" } })) });

/** Writes the overview in one short Claude pass, then runs the citation check (the second reader is checkOverview). */
export async function writeOverview(llm: LlmProvider, facts: Facts, root: string, { signal }: { signal?: AbortSignal } = {}): Promise<ProjectOverview> {
  const result = await llm.ask({ system: OVERVIEW_SYSTEM, prompt: discoveryDigest(facts), schema: OverviewSchema, tools: llm.canRead ? "read" : "none", cwd: root, effort: "low", signal });
  const d = result.data;
  const notes: string[] = [];
  const files = facts.files.map((f) => f.path);
  // A part must live somewhere real: a file in the repo, or a folder that holds some.
  const parts = d.parts.flatMap((p) => {
    const path = p.path.trim().replace(/^\.\//, "").replace(/\/+$/, "");
    if (files.some((f) => f === path || f.startsWith(`${path}/`))) return [{ name: redact(p.name), path, does: pending(p.does) }];
    notes.push(`dropped part "${p.name}": ${p.path} isn't in the repo`);
    return [];
  });
  const overview: ProjectOverview = {
    version: 1, generatedAt: new Date().toISOString(), model: result.model, status: "checking",
    what: pending(d.what), how: pending(d.how), parts,
    talksTo: d.talksTo.map((t) => ({ name: redact(t.name), does: pending(t.does) })),
    notes,
  };
  return citeOverview(overview, facts, root);
}

const claimsOf = (o: ProjectOverview): AnalysisClaim[] => [o.what, o.how, ...o.parts.map((p) => p.does), ...o.talksTo.map((t) => t.does)];

function putClaims(o: ProjectOverview, claims: AnalysisClaim[]): ProjectOverview {
  let i = 0;
  const next = () => claims[i++]!;
  return { ...o, what: next(), how: next(), parts: o.parts.map((p) => ({ ...p, does: next() })), talksTo: o.talksTo.map((t) => ({ ...t, does: next() })) };
}

/** Runs the citation check over every sentence (fast, no Claude). */
export function citeOverview(o: ProjectOverview, facts: Facts, root: string): ProjectOverview {
  const raw = claimsOf(o).map(({ evidence, ...c }) => ({ ...c, evidence: evidence.map(({ check: _, ...e }) => e) }));
  const checked = makeChecker(root, facts).apply({ summary: "", analogy: "", status: "unknown", statusReason: "", flow: [], issues: [], claims: raw }).claims;
  return putClaims(o, checked);
}

/** The second reader: tries to refute every confirmed sentence, then the overview is "checked". */
export async function checkOverview(llm: LlmProvider, facts: Facts, root: string, o: ProjectOverview, { signal }: { signal?: AbortSignal } = {}): Promise<ProjectOverview> {
  const reviewed = await refuteClaims(llm, facts, root, claimsOf(o), signal);
  return { ...putClaims(o, reviewed), status: "checked" };
}
