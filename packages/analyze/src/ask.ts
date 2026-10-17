import type { Facts } from "@docent/extract";
import type { LlmProvider } from "@docent/llm";
import { makeChecker } from "./citations.ts";
import { refuteClaims } from "./refute.ts";
import { AnswerSchema } from "./schemas.ts";
import type { AnalysisClaim } from "./types.ts";

const SYSTEM = `You are Docent, explaining a codebase to the developer who owns it but didn't write it. They are looking at one view of it and asked a question about what's on screen.

How to answer:
- Plain words first, like a senior engineer at a whiteboard. Short paragraphs, one idea each. Lead with the direct answer.
- Read the code (you have read-only tools in the repo) before claiming anything about behavior. The context below is a starting point, not the whole story.
- Every paragraph is a claim and carries a label and evidence: file, start line, end line, and in "mentions" identifiers or exact short snippets that appear in those lines. A script checks them; a second reader tries to refute every confirmed claim.
  "confirmed" = you read it in the code. "inferred" = a reasoned guess. "unknown" = can't be determined from this repo (say what's missing). "record" = from a commit message (give the sha).
- A claim that something never happens has no line to cite: say what you searched in "searched".
- Docs and agent notes are hints and may be stale. When they disagree with the code, say so.
- Never invent a reason. If no commit, comment or doc records why, say "No recorded reason found."
- If the question can't be answered from this repo, say so plainly as an unknown.

The scene shows the answer on the canvas the developer is looking at:
- Use only box refs (b1, b2…) and links from the on-screen list. Never invent boxes; if what you need isn't on screen, leave the scene empty and mention which view would show it.
- 2 to 6 steps, in the order things happen. Each step lights a few boxes and the links between them, with one short caption.`;

export interface AskBox { id: string; title: string; sub?: string }
export interface AskInput {
  question: string;
  /** What the view shows, as text the server built from the facts and analyses. */
  context: string;
  boxes: AskBox[];
  links: { from: string; to: string; label?: string }[];
  history: { question: string; answer: string }[];
}
export interface CheckedAnswer {
  paragraphs: AnalysisClaim[];
  /** Box and link ids are the canvas's own, mapped back from the refs Claude saw. */
  scene: { nodes: string[]; edges: { from: string; to: string }[]; caption: string }[];
  model: string;
}

export async function answerQuestion(
  llm: LlmProvider,
  facts: Facts,
  root: string,
  input: AskInput,
  { signal, onStage, onDraft }: { signal?: AbortSignal; onStage?: (stage: "answering" | "checking") => void; onDraft?: (a: CheckedAnswer) => void } = {},
): Promise<CheckedAnswer> {
  const ref = new Map(input.boxes.map((b, i) => [`b${i + 1}`, b.id]));
  const refOf = new Map(input.boxes.map((b, i) => [b.id, `b${i + 1}`]));
  const linkRefs = input.links.flatMap((l) => (refOf.has(l.from) && refOf.has(l.to) ? [`${refOf.get(l.from)} → ${refOf.get(l.to)}${l.label ? ` (${l.label})` : ""}`] : []));
  const prompt = [
    input.context,
    "",
    "On screen now:",
    ...input.boxes.map((b, i) => `- b${i + 1}: ${b.title}${b.sub ? ` · ${b.sub}` : ""}`),
    linkRefs.length ? `Links: ${linkRefs.join("; ")}` : "Links: none",
    ...(input.history.length ? ["", "Earlier in this conversation:", ...input.history.slice(-4).flatMap((h) => [`Q: ${h.question}`, `A: ${h.answer}`])] : []),
    "",
    `Question: ${input.question}`,
  ].join("\n");

  onStage?.("answering");
  const result = await llm.ask({ system: SYSTEM, prompt, schema: AnswerSchema, tools: llm.canRead ? "read" : "none", cwd: root, effort: "medium", signal });

  onStage?.("checking");
  const checked = makeChecker(root, facts).apply({
    summary: "", analogy: "", status: "unknown", statusReason: "", flow: [], issues: [],
    claims: result.data.paragraphs.map((p) => ({ ...p, kind: "behavior" as const })),
  });
  // Only boxes and links that are really on screen survive; a step left with nothing to show is dropped.
  const real = new Set(input.links.map((l) => `${l.from}>${l.to}`));
  const scene = result.data.scene.map((s) => {
    const nodes = s.boxes.map((b) => ref.get(b.trim())).filter((id): id is string => !!id);
    // A link named backwards is turned the way it really points, so particles flow the right way.
    const edges = s.links.flatMap((l) => {
      const a = ref.get(l.from.trim());
      const b = ref.get(l.to.trim());
      if (!a || !b) return [];
      if (real.has(`${a}>${b}`)) return [{ from: a, to: b }];
      if (real.has(`${b}>${a}`)) return [{ from: b, to: a }];
      return [];
    });
    return { nodes, edges, caption: s.caption };
  }).filter((s) => s.nodes.length || s.edges.length);

  // The citation check is instant: the answer can be read now, while the second reader settles its labels.
  onDraft?.({ paragraphs: checked.claims, scene, model: result.model });
  const paragraphs = await refuteClaims(llm, facts, root, checked.claims, signal);
  return { paragraphs, scene, model: result.model };
}
