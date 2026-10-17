import { describe, expect, it } from "vitest";
import type { Facts } from "@docent/extract";
import type { LlmProvider } from "@docent/llm";
import { refuteClaims } from "../src/index.ts";
import type { AnalysisClaim } from "../src/types.ts";

const claim = (text: string, label: AnalysisClaim["label"] = "confirmed"): AnalysisClaim =>
  ({ text, label, kind: "behavior", evidence: [], commit: "", searched: "" }) as AnalysisClaim;

/** A second reader that upholds even-numbered claims and refutes odd ones, and also answers for a claim it wasn't shown. */
function fakeReader() {
  const calls: { ids: number[]; effort?: string }[] = [];
  let running = 0;
  let most = 0;
  const llm = {
    id: "api",
    describe: () => "fake",
    async ask(opts: { prompt: string; effort?: string }) {
      running++;
      most = Math.max(most, running);
      const ids = [...opts.prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
      calls.push({ ids, effort: opts.effort });
      await new Promise((r) => setTimeout(r, 20));
      running--;
      const verdicts = [...ids, 999].map((id) => ({ id, verdict: id % 2 ? "refuted" : "upheld", reason: `saw ${id}` }));
      return { data: { verdicts }, provider: "api", model: "m", durationMs: 0, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };
    },
  } as unknown as LlmProvider;
  return { llm, calls, most: () => most };
}

describe("second reader in batches", () => {
  it("checks claims in parallel batches at low effort and folds every verdict back in place", async () => {
    const claims = Array.from({ length: 14 }, (_, i) => claim(`claim ${i}`, i === 3 ? "inferred" : "confirmed"));
    const { llm, calls, most } = fakeReader();
    const out = await refuteClaims(llm, { commits: [] } as unknown as Facts, "/", claims);
    // 13 claims need review (one is only inferred): batches of 6, at most 3 at once.
    expect(calls.map((c) => c.ids.length).sort()).toEqual([1, 6, 6]);
    expect(calls.every((c) => c.effort === "low")).toBe(true);
    expect(most()).toBeGreaterThan(1);
    expect(out[0]).toMatchObject({ label: "confirmed", review: { verdict: "upheld", reason: "saw 0" } });
    expect(out[1]).toMatchObject({ label: "unknown", claimedLabel: "confirmed" });
    expect(out[3]).toEqual(claims[3]);
    expect(out[13]).toMatchObject({ label: "unknown", review: { reason: "saw 13" } });
  });
});
