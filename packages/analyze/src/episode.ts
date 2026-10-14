import type { Facts } from "@docent/extract";
import { redact, type LlmProvider } from "@docent/llm";
import { makeChecker } from "./citations.ts";
import { featureDigest } from "./digest.ts";
import { refuteClaims } from "./refute.ts";
import { EpisodeSchema, type EpisodeSpec } from "./schemas.ts";
import type { AnalysisClaim, Feature, FeatureAnalysis } from "./types.ts";
import { filesHash } from "./verify.ts";

const SYSTEM = `You are Docent, writing a short narrated, animated lesson (an "episode") that teaches one feature of a codebase to the developer who owns it but didn't write it. Think of a senior engineer at a whiteboard, or a good YouTube explainer. The goal is ownership: afterwards they can say what it does, how a request flows through it, where they'd change something, what would break, and where to look first when it's wrong.

Content rules:
- Build only on what is established. The verified analysis below lists claims with labels; read the code (read-only tools) for anything more. Never state as fact something you haven't read.
- Every step carries one claim with evidence: file, start line, end line, and "mentions" (identifiers or short exact snippets in those lines). A script checks them and a second reader tries to refute every confirmed claim. The narration and caption must not say more than the step's claim.
- Labels: "confirmed" = read in the code. "inferred" = a reasoned guess. "unknown" = can't be determined from this repo. "record" = a commit message says so (give the sha).
- Never invent a reason. If no commit, comment or doc records why, say there's no recorded reason.
- Be honest about the mess: a scene on what can go wrong, the issues verification found, and where to look first.

Teaching rules:
- The intro and analogy come before any file names.
- Each scene teaches one idea. Each step pairs a few lit boxes with one spoken line of about 35 words.
- Narration is for the ear: plain words, no paths, symbols or code read aloud. Captions carry the precise names.
- Give each step a tone for the narrator: mostly calm; warm when a part is solid, curious for a question, concerned for a risk or something not to trust, emphatic for the one thing to remember. A bit opinionated, never theatrical.
- Packets are what moves along a link ("front photo", "signed targets", "403 · expired"). Use them whenever data moves.
- One or two "predict" steps: ask what happens before showing it. The reveal is a claim with evidence.
- The cast is small (3 to 8 boxes): where the user acts, the few pieces of code that matter, and what's outside (an API, storage). Each box points at the real file and lines it stands for. Lanes run left to right in the order things happen.
- Self-check: exactly these five questions, answered for this feature: What does it do, in one sentence? How does a request flow through it? Where would I change it? What would break if I did? Where do I look first when it's wrong?
- The exercise is a small change the learner makes by hand in the real repo, with a way to check it (a test to run, or what to observe).`;

type Claim = EpisodeSpec["scenes"][number]["steps"][number]["claim"];
type CastItem = EpisodeSpec["cast"][number];

export interface Episode {
  version: 1;
  featureId: string;
  generatedAt: string;
  model: string;
  provider: string;
  /** Same hash as the analysis: when the feature's code changes, the episode is stale. */
  filesHash: string;
  title: string;
  intro: string;
  analogy: string;
  cast: CastItem[];
  links: EpisodeSpec["links"];
  scenes: {
    title: string;
    objective: string;
    steps: (Omit<EpisodeSpec["scenes"][number]["steps"][number], "claim" | "predict" | "code" | "tone"> & {
      /** How the narrator says it. Episodes written before tones existed have none. */
      tone?: EpisodeSpec["scenes"][number]["steps"][number]["tone"];
      code: { file: string; start: number; end: number } | null;
      claim: AnalysisClaim;
      predict: { question: string; options: { text: string; correct: boolean }[]; reveal: AnalysisClaim } | null;
    })[];
  }[];
  selfCheck: { question: string; answer: AnalysisClaim }[];
  exercise: EpisodeSpec["exercise"];
  /** What the mechanical clean-up dropped or fixed in Claude's draft. */
  notes: string[];
}

export async function writeEpisode(
  llm: LlmProvider,
  facts: Facts,
  root: string,
  feature: Feature,
  analysis: FeatureAnalysis,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Episode> {
  const prompt = [
    `Feature: ${feature.name} (${feature.id}) — ${analysis.summary}`,
    `Analogy from verification: ${analysis.analogy}`,
    `Status: ${analysis.status}. ${analysis.statusReason}`,
    "",
    "The verified flow, in order:",
    ...analysis.flow.map((s, i) => `${i + 1}. ${s.step} (${s.symbol || s.file}:${s.start}-${s.end})${s.check.ok ? "" : " [citation failed]"}`),
    "",
    "What verification established (label, claim, evidence):",
    ...analysis.claims.map((c) => `- [${c.label}] (${c.kind}) ${c.text}${c.evidence[0] ? ` — ${c.evidence[0].file}:${c.evidence[0].start}-${c.evidence[0].end}` : ""}${c.label === "record" ? ` (commit ${c.commit})` : ""}`),
    "",
    "Issues found:",
    ...analysis.issues.map((i) => `- [${i.severity}] ${i.title}: ${i.detail}${i.evidence[0] ? ` — ${i.evidence[0].file}:${i.evidence[0].start}` : ""}`),
    "",
    featureDigest(facts, feature.files),
  ].join("\n");
  const result = await llm.ask({ system: SYSTEM, prompt, schema: EpisodeSchema, tools: llm.id === "claude-code" ? "read" : "none", cwd: root, effort: "high", signal });
  const { episode, claims } = clean(result.data, facts);

  // Every claim the episode makes goes through the citation check and the second reader.
  const checked = makeChecker(root, facts).apply({
    summary: "", analogy: "", status: "unknown", statusReason: "", flow: [], issues: [],
    claims: claims.map((c) => ({ ...c, kind: "behavior" as const })),
  });
  const reviewed = await refuteClaims(llm, facts, root, checked.claims, signal);
  let n = 0;
  const next = () => reviewed[n++]!;
  return {
    version: 1,
    featureId: feature.id,
    generatedAt: new Date().toISOString(),
    model: result.model,
    provider: result.provider,
    filesHash: filesHash(facts, feature.files),
    ...episode,
    scenes: episode.scenes.map((s) => ({
      ...s,
      steps: s.steps.map((st) => ({ ...st, claim: next(), predict: st.predict ? { ...st.predict, reveal: next() } : null })),
    })),
    selfCheck: episode.selfCheck.map((q) => ({ question: q.question, answer: next() })),
  };
}

/**
 * The mechanical clean-up: boxes must stand for real files and symbols, links and packets must join
 * real boxes, and code ranges must exist. Returns the cleaned episode and its claims in reading order.
 */
export function clean(spec: EpisodeSpec, facts: Facts) {
  const notes: string[] = [];
  const files = new Map(facts.files.map((f) => [f.path, f]));
  const symbols = new Set(facts.symbols.map((s) => s.id));

  const cast = spec.cast.flatMap((c): CastItem[] => {
    const outside = c.kind === "external" || c.kind === "service" || c.kind === "data";
    if (!c.file) return outside ? [{ ...c, symbol: "", start: 0, end: 0 }] : (notes.push(`dropped box "${c.title}": no file`), []);
    const file = files.get(c.file);
    if (!file) return (notes.push(`dropped box "${c.title}": ${c.file} isn't in the repo`), []);
    const symbol = c.symbol && !symbols.has(c.symbol) ? (notes.push(`box "${c.title}": no symbol ${c.symbol}`), "") : c.symbol;
    const lines = c.start >= 1 && c.end >= c.start && c.end <= file.lines ? { start: c.start, end: c.end } : { start: 0, end: 0 };
    return [{ ...c, symbol, ...lines }];
  });
  const ids = new Set(cast.map((c) => c.id));
  const links = spec.links.filter((l) => (ids.has(l.from) && ids.has(l.to)) || (notes.push(`dropped link ${l.id}`), false));
  const linkIds = new Set(links.map((l) => l.id));
  const codeOk = (c: { file: string; start: number; end: number }) => {
    const f = files.get(c.file);
    return !!f && c.start >= 1 && c.end >= c.start && c.start <= f.lines;
  };

  const claims: Claim[] = [];
  const scenes = spec.scenes.map((s) => ({
    title: s.title,
    objective: s.objective,
    steps: s.steps.map((st) => {
      claims.push(st.claim);
      if (st.predict) claims.push(st.predict.reveal);
      return {
        boxes: st.boxes.filter((b) => ids.has(b)),
        links: st.links.filter((l) => linkIds.has(l)),
        packets: st.packets.filter((p) => linkIds.has(p.link)),
        code: st.code.file && codeOk(st.code) ? { file: st.code.file, start: st.code.start, end: Math.min(st.code.end, files.get(st.code.file)!.lines) } : null,
        say: redact(st.say),
        tone: st.tone,
        caption: redact(st.caption),
        predict: st.predict && st.predict.options.some((o) => o.correct) ? { question: st.predict.question, options: st.predict.options } : null,
      };
    }),
  }));
  for (const q of spec.selfCheck) claims.push(q.answer);
  return {
    episode: { title: spec.title, intro: spec.intro, analogy: spec.analogy, cast, links, scenes, selfCheck: spec.selfCheck.map((q) => ({ question: q.question })), exercise: spec.exercise, notes },
    claims,
  };
}

export type NarrationTone = NonNullable<Episode["scenes"][number]["steps"][number]["tone"]>;

/**
 * What the narrator says at a step, and how: a predict step asks its question (curious); any other step
 * says its narration in the tone the writer chose. Episodes written before tones existed infer one.
 */
export function narrationLine(e: Episode, at: number): { text: string; tone: NarrationTone } | null {
  const found = e.scenes.flatMap((scene) => scene.steps.map((step) => ({ scene, step })))[at];
  if (!found) return null;
  const { scene, step } = found;
  if (step.predict) return { text: step.predict.question, tone: "curious" };
  if (step.tone) return { text: step.say, tone: step.tone };
  if (/\?\s*$/.test(step.say)) return { text: step.say, tone: "curious" };
  if (/wrong|break|risk|careful|fail|trust/i.test(`${scene.title} ${scene.objective}`)) return { text: step.say, tone: "concerned" };
  return { text: step.say, tone: "calm" };
}
