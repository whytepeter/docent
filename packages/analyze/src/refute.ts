import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Facts } from "@docent/extract";
import type { LlmProvider } from "@docent/llm";
import { RefuteSchema, type Refutation } from "./schemas.ts";
import type { AnalysisClaim } from "./types.ts";

const SYSTEM = `You are the second reader. Another engineer wrote the claims below about a codebase; you did not. Your job is to try to refute each one.

For each claim, read the cited code (shown below; open files for more context if you need it) and decide:
- "upheld": the code shows the claim is true as worded.
- "refuted": the code contradicts it, or it overstates (says "always" where some path doesn't, names the wrong function, describes behavior that isn't there).
- "unsure": the cited code doesn't establish it either way.

Rules:
- A citation pointing at the right lines is not proof. Check that the lines actually do what the claim says.
- A claim that something is absent or never happens: repeat the search yourself before upholding it. Uphold only if your search finds nothing that contradicts it, and say what you searched.
- A "record" claim: uphold only if the commit message actually states that reason. A plausible reason the commit doesn't state is refuted.
- Be strict. An upheld claim is shown to the developer as confirmed fact.
- Return a verdict for every claim number, with one short reason naming what you saw.`;

const SLACK = 2;
const MAX_LINES = 40;

/** Claims the second reader looks at: everything that would be shown as fact. */
export const needsReview = (c: AnalysisClaim) => c.label === "confirmed" || c.label === "record";

/** Claims per second-reader run, and how many runs go at once. */
const BATCH = 6;
const PARALLEL = 3;

/**
 * The second reader, in batches run side by side: each batch is a separate session that sees only its own
 * claims (numbered as on the board, so verdicts fold back in place). Low effort: the cited code is in the
 * prompt, and the job is to check it, not to explore.
 */
export async function refuteClaims(llm: LlmProvider, facts: Facts, root: string, claims: AnalysisClaim[], signal?: AbortSignal): Promise<AnalysisClaim[]> {
  const ids = claims.flatMap((c, i) => (needsReview(c) ? [i] : []));
  if (!ids.length) return claims;
  const batches = Array.from({ length: Math.ceil(ids.length / BATCH) }, (_, b) => ids.slice(b * BATCH, (b + 1) * BATCH));
  const verdicts: Refutation["verdicts"] = [];
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      const result = await llm.ask({
        system: SYSTEM,
        prompt: reviewPrompt(facts, root, claims, batch),
        schema: RefuteSchema,
        tools: llm.id === "claude-code" ? "read" : "none",
        cwd: root,
        effort: "low",
        signal,
      });
      // Only verdicts for this batch's own claims count.
      const mine = new Set(batch);
      verdicts.push(...result.data.verdicts.filter((v) => mine.has(v.id)));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
  return applyReview(claims, verdicts);
}

/**
 * Folds the verdicts in. Only "upheld" keeps a claim's label; "unsure" drops it to inferred,
 * "refuted" to unknown, and a claim the reader skipped is treated as unsure. Never promotes.
 */
export function applyReview(claims: AnalysisClaim[], verdicts: Refutation["verdicts"]): AnalysisClaim[] {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  return claims.map((c, i): AnalysisClaim => {
    if (!needsReview(c)) return c;
    const v = byId.get(i);
    if (!v) return { ...c, label: "inferred", claimedLabel: c.claimedLabel ?? c.label, checkNote: "the second reader returned no verdict" };
    const review = { verdict: v.verdict, reason: v.reason };
    if (v.verdict === "upheld") return { ...c, review };
    const label = v.verdict === "refuted" ? "unknown" : "inferred";
    const note = v.verdict === "refuted" ? `a second reader disputes it: ${v.reason}` : `a second reader couldn't confirm it: ${v.reason}`;
    return { ...c, review, label, claimedLabel: c.claimedLabel ?? c.label, checkNote: note };
  });
}

function reviewPrompt(facts: Facts, root: string, claims: AnalysisClaim[], ids: number[]): string {
  const files = new Map<string, string[]>();
  const lines = (file: string) => {
    if (!files.has(file)) files.set(file, readFileSync(join(root, file), "utf8").split("\n"));
    return files.get(file)!;
  };
  const out: string[] = [];
  for (const i of ids) {
    const c = claims[i]!;
    out.push(`[${i}] ${c.label} · ${c.kind}`, `Claim: ${c.text}`);
    if (c.searched?.trim()) out.push(`Claim of absence. The writer searched: ${c.searched}`);
    if (c.label === "record") {
      const commit = facts.commits.find((m) => m.sha.startsWith(c.commit) || c.commit.startsWith(m.sha));
      out.push(commit ? `Commit ${commit.sha.slice(0, 7)}: ${commit.subject}${commit.body ? `\n${commit.body.split("\n").slice(0, 12).join("\n")}` : ""}` : `Commit ${c.commit}: not found`);
    }
    for (const e of c.evidence) {
      if (!e.check.ok) continue;
      const all = lines(e.file);
      const from = Math.max(1, e.start - SLACK);
      const to = Math.min(all.length, e.end + SLACK, from + MAX_LINES - 1);
      out.push(`Cited ${e.file}:${e.start}–${e.end}`);
      for (let n = from; n <= to; n++) out.push(`  ${n} | ${all[n - 1]}`);
    }
    out.push("");
  }
  return out.join("\n");
}
