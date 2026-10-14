import type { Facts } from "@docent/extract";
import type { LlmProvider } from "@docent/llm";
import { discoveryDigest } from "./digest.ts";
import { DiscoverySchema } from "./schemas.ts";
import type { Feature, FeatureMap } from "./types.ts";

const SYSTEM = `You map an unfamiliar codebase into features for a developer who must come to own it.

A feature is a capability a user or operator would recognize ("Upload ID document", "Face liveness check", "Resume on another device"), not a technical layer ("utils", "components"). Shared foundations (an API client, design system, i18n) become their own features of kind "shared".

Rules:
- Start from entry points and follow the imports. Use co-change history for boundaries. Do not group by folder name alone.
- The facts list is complete and correct. Use only file paths and symbol ids that appear in it. Never invent paths.
- Docs and agent notes are hints and may be stale. When you read code to check something, the code wins.
- Aim for 5 to 15 features. Every non-test source file belongs to exactly one feature, or goes to "unassigned" with an honest guess why (dead code, unused, generated).
- Keep names plain and short. The summary is one sentence a newcomer understands.
- You may read files to settle a doubt, but stay brief: the facts below are the main source.`;

export async function discoverFeatures(llm: LlmProvider, facts: Facts, root: string, signal?: AbortSignal): Promise<FeatureMap> {
  const result = await llm.ask({
    system: SYSTEM,
    prompt: `Here are the facts extracted from the repository. Propose its feature map.\n\n${discoveryDigest(facts)}`,
    schema: DiscoverySchema,
    tools: llm.id === "claude-code" ? "read" : "none",
    cwd: root,
    effort: "medium",
    signal,
  });
  return validateDiscovery(result.data, facts, { model: result.model, provider: result.provider });
}

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "feature";

/** Mechanical clean-up of Claude's proposal: drop what doesn't exist, make ids unique, account for every file. */
export function validateDiscovery(d: typeof DiscoverySchema._output, facts: Facts, meta: { model: string; provider: string }): FeatureMap {
  const notes: string[] = [];
  const sourceFiles = new Set(facts.files.filter((f) => f.kind === "source" || f.kind === "generated").map((f) => f.path));
  const symbolIds = new Set(facts.symbols.map((s) => s.id));
  const seenIds = new Set<string>();
  const owner = new Map<string, string>();
  const features: Feature[] = [];

  for (const raw of d.features) {
    let id = kebab(raw.id || raw.name);
    while (seenIds.has(id)) id = `${id}-2`;
    seenIds.add(id);
    const files = [...new Set(raw.files)].filter((f) => {
      if (sourceFiles.has(f)) return true;
      notes.push(`${id}: dropped “${f}”, not a source file in the repo`);
      return false;
    });
    const entryPoints = raw.entryPoints.filter((e) => {
      if (symbolIds.has(e) || sourceFiles.has(e)) return true;
      notes.push(`${id}: dropped entry point “${e}”, not found`);
      return false;
    });
    for (const f of files) {
      if (owner.has(f)) notes.push(`${f} was in both ${owner.get(f)} and ${id}; kept in ${owner.get(f)}`);
      else owner.set(f, id);
    }
    features.push({ ...raw, id, files: files.filter((f) => owner.get(f) === id), entryPoints });
  }
  const unassigned = d.unassigned.filter((u) => sourceFiles.has(u.file) && !owner.has(u.file));
  for (const f of sourceFiles) {
    if (!owner.has(f) && !unassigned.some((u) => u.file === f)) unassigned.push({ file: f, guess: "Not placed by discovery" });
  }
  return {
    version: 1,
    state: "proposed",
    commit: facts.repo.head,
    proposedAt: new Date().toISOString(),
    model: meta.model,
    provider: meta.provider,
    features: features.filter((f) => f.files.length > 0 || (notes.push(`${f.id}: removed, no real files left`), false)),
    unassigned,
    notes,
  };
}
