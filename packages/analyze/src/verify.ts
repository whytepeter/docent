import { createHash } from "node:crypto";
import type { Facts } from "@docent/extract";
import type { LlmProvider } from "@docent/llm";
import { makeChecker } from "./citations.ts";
import { featureDigest } from "./digest.ts";
import { refuteClaims } from "./refute.ts";
import { VerifySchema } from "./schemas.ts";
import type { Feature, FeatureAnalysis } from "./types.ts";

const SYSTEM = `You are verifying one feature of a codebase for a developer who must come to own it. Act like a careful senior engineer.

Trace the feature end to end, from the user's action to the result: UI → state → API → storage/external, as it applies. Read the code to confirm each step.

Every claim must be checkable:
- Cite file, start line, end line, and in "mentions" the identifiers or exact short snippets that appear in those lines and prove the claim. A script will check them; a claim whose citation fails is demoted.
- label "confirmed" = you read it in the code. "inferred" = a reasoned guess from structure. "unknown" = you couldn't tell. "record" = the reason comes from a commit message (put its sha in "commit").
- A claim that something is absent or never happens ("nothing cancels the other upload") has no line to cite: put what you searched in "searched". A second reader will repeat the search.
- A second reader will try to refute every confirmed and record claim. Word claims exactly; don't overstate.
- "why" claims need a record (commit, comment, doc) or must say there is no recorded reason and be labeled inferred. Never invent a rationale.
- Docs are hints. If a doc contradicts the code, add a claim of kind "doc-mismatch" citing both.
- Include invariants (what must stay true), risks (what breaks if changed), and real issues (dead code, duplicated logic, half-finished parts). Silence about problems is a failure.
- Plain words in summary, analogy and flow steps. Precise names belong in citations.
- If something can't be verified in a few reads, mark it unknown and move on.`;

export const filesHash = (facts: Facts, files: string[]) => {
  const byPath = new Map(facts.files.map((f) => [f.path, f.hash]));
  return createHash("sha1").update(files.slice().sort().map((f) => `${f}:${byPath.get(f) ?? "?"}`).join("\n")).digest("hex").slice(0, 16);
};

export async function verifyFeature(llm: LlmProvider, facts: Facts, root: string, feature: Feature, signal?: AbortSignal): Promise<FeatureAnalysis> {
  const prompt = [
    `Feature: ${feature.name} (${feature.id}) — ${feature.summary}`,
    `Kind: ${feature.kind}`,
    `Entry points: ${feature.entryPoints.join(", ") || "none listed"}`,
    `Files:\n${feature.files.map((f) => `- ${f}`).join("\n")}`,
    "",
    featureDigest(facts, feature.files),
  ].join("\n");
  const result = await llm.ask({
    system: SYSTEM,
    prompt,
    schema: VerifySchema,
    tools: llm.id === "claude-code" ? "read" : "none",
    cwd: root,
    effort: "medium",
    signal,
  });
  const checked = makeChecker(root, facts).apply(result.data);
  // A separate session, with none of this one's context, tries to refute what survived the citation check.
  checked.claims = await refuteClaims(llm, facts, root, checked.claims, signal);
  return {
    version: 1,
    featureId: feature.id,
    generatedAt: new Date().toISOString(),
    model: result.model,
    provider: result.provider,
    filesHash: filesHash(facts, feature.files),
    summary: result.data.summary,
    analogy: result.data.analogy,
    status: result.data.status,
    statusReason: result.data.statusReason,
    ...checked,
  };
}

/** Runs workers in parallel, a few at a time, so a subscription isn't hammered. */
export async function verifyAll(
  llm: LlmProvider,
  facts: Facts,
  root: string,
  features: Feature[],
  { concurrency = 3, onDone, signal }: { concurrency?: number; onDone?: (id: string, result: FeatureAnalysis | Error) => void; signal?: AbortSignal } = {},
): Promise<Map<string, FeatureAnalysis | Error>> {
  const results = new Map<string, FeatureAnalysis | Error>();
  const queue = [...features];
  const worker = async () => {
    // A cancelled run stops taking new features; the ones in flight are killed through the signal.
    for (let f = queue.shift(); f && !signal?.aborted; f = queue.shift()) {
      try {
        const r = await verifyFeature(llm, facts, root, f, signal);
        results.set(f.id, r);
        onDone?.(f.id, r);
      } catch (error) {
        if (signal?.aborted) return;
        results.set(f.id, error as Error);
        onDone?.(f.id, error as Error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, features.length) }, worker));
  return results;
}
