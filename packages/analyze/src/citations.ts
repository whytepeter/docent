import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Facts } from "@docent/extract";
import type { Verification } from "./schemas.ts";
import type { CheckResult, CheckedEvidence, FeatureAnalysis } from "./types.ts";

const SLACK = 2; // lines of tolerance either side of a cited range

/**
 * The citation check: a claim only stays "confirmed" if every line range it cites exists
 * and actually contains the identifiers it names. Anything else is demoted, never silently kept.
 * Passing proves the citation points at the right code, not that the claim is true; that's the
 * second reader's job (refute.ts). The check can only demote, never promote.
 */
export function makeChecker(root: string, facts: Facts) {
  const known = new Set(facts.files.map((f) => f.path));
  const cache = new Map<string, string[]>();
  const linesOf = (file: string) => {
    if (!cache.has(file)) cache.set(file, readFileSync(join(root, file), "utf8").split("\n"));
    return cache.get(file)!;
  };

  const checkEvidence = (e: { file: string; start: number; end: number; mentions: string[] }): CheckResult => {
    if (!known.has(e.file)) return { ok: false, reason: `no file ${e.file} in the repo` };
    const lines = linesOf(e.file);
    if (e.start < 1 || e.start > lines.length || e.end < e.start) return { ok: false, reason: `lines ${e.start}–${e.end} don't exist (file has ${lines.length})` };
    const named = e.mentions.map((m) => m.trim()).filter(Boolean);
    if (!named.length) return { ok: false, reason: `lines ${e.start}–${e.end} cite nothing to look for` };
    const text = lines.slice(Math.max(0, e.start - 1 - SLACK), Math.min(lines.length, e.end + SLACK)).join("\n");
    const missing = named.filter((m) => !text.includes(m));
    return missing.length ? { ok: false, reason: `not in lines ${e.start}–${e.end}: ${missing.map((m) => `“${m}”`).join(", ")}` } : { ok: true };
  };

  const commitExists = (sha: string) => !!sha && facts.commits.some((c) => c.sha.startsWith(sha) || sha.startsWith(c.sha));

  return {
    checkEvidence,
    apply(v: Verification): Pick<FeatureAnalysis, "flow" | "claims" | "issues"> {
      const withChecks = (ev: Verification["claims"][number]["evidence"]): CheckedEvidence[] => ev.map((e) => ({ ...e, check: checkEvidence(e) }));
      const claims = v.claims.map((c) => {
        const evidence = withChecks(c.evidence);
        const failed = evidence.filter((e) => !e.check.ok);
        if (c.label === "record") {
          if (commitExists(c.commit)) return { ...c, evidence };
          return { ...c, evidence, label: "unknown" as const, claimedLabel: c.label, checkNote: `the check found no commit ${c.commit || "(none)"} in history` };
        }
        // A claim of absence has nothing to cite; it must say what was searched instead, and the second reader repeats the search.
        const uncited = !evidence.length && !c.searched?.trim();
        if (c.label === "confirmed" && (failed.length || uncited)) {
          return { ...c, evidence, label: "inferred" as const, claimedLabel: c.label, checkNote: `the citation check found ${failed[0]?.check.reason ?? "no evidence and no search behind it"}` };
        }
        return { ...c, evidence };
      });
      return {
        flow: v.flow.map((s) => ({ ...s, check: checkEvidence(s) })),
        claims,
        issues: v.issues.map((i) => ({ ...i, evidence: withChecks(i.evidence) })),
      };
    },
  };
}
