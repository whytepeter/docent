import { z } from "@docent/llm";

/** What Claude must return when proposing features. Every path and id is checked against the facts afterwards. */
export const DiscoverySchema = z.object({
  features: z.array(z.object({
    id: z.string().describe("kebab-case, stable, e.g. document-upload"),
    name: z.string().describe("What a user or operator would call it, e.g. 'Upload ID document'"),
    summary: z.string().describe("One plain sentence: what it does for the user"),
    kind: z.enum(["user-facing", "operator", "background", "shared"]),
    entryPoints: z.array(z.string()).describe("Symbol ids (path#Name) or file paths where it starts"),
    files: z.array(z.string()).describe("Repo-relative source files that belong to it"),
    reason: z.string().describe("Why these files form one feature: the facts you used"),
    confidence: z.enum(["high", "medium", "low"]),
  })),
  unassigned: z.array(z.object({ file: z.string(), guess: z.string() })),
});
export type Discovery = z.infer<typeof DiscoverySchema>;

const Evidence = z.object({
  file: z.string(),
  start: z.number().int(),
  end: z.number().int(),
  mentions: z.array(z.string()).describe("Identifiers or exact snippets that must appear in these lines for the claim to hold"),
});

/** What a verification worker returns for one feature. */
export const VerifySchema = z.object({
  summary: z.string().describe("One plain sentence a newcomer understands"),
  analogy: z.string().describe("One everyday analogy for the mental model, before any file names"),
  status: z.enum(["working", "partial", "dead", "unknown"]),
  statusReason: z.string(),
  flow: z.array(z.object({
    step: z.string().describe("Plain words: what happens at this step"),
    symbol: z.string().describe("Symbol id from the list, or empty if none"),
    file: z.string(),
    start: z.number().int(),
    end: z.number().int(),
    mentions: z.array(z.string()),
  })).describe("The main path through the feature, in order, from the user's action to the result"),
  claims: z.array(z.object({
    text: z.string(),
    kind: z.enum(["behavior", "invariant", "why", "risk", "doc-mismatch"]),
    label: z.enum(["confirmed", "inferred", "unknown", "record"]),
    evidence: z.array(Evidence),
    commit: z.string().describe("For 'record' claims: the commit sha that records the reason; otherwise empty"),
    searched: z.string().describe("For a claim that something is absent or never happens: what you searched (patterns, folders) to conclude it; otherwise empty"),
  })),
  issues: z.array(z.object({
    title: z.string(),
    detail: z.string(),
    severity: z.enum(["high", "medium", "low"]),
    evidence: z.array(Evidence),
  })),
});
export type Verification = z.infer<typeof VerifySchema>;

/** What the second reader returns: one verdict per claim it was shown. */
export const RefuteSchema = z.object({
  verdicts: z.array(z.object({
    id: z.number().int().describe("The claim's number as shown"),
    verdict: z.enum(["upheld", "refuted", "unsure"]),
    reason: z.string().describe("One short sentence naming what you saw in the code or commit"),
  })),
});
export type Refutation = z.infer<typeof RefuteSchema>;

/** What Claude returns for a question asked from a view: checked paragraphs, and a scene that shows the answer. */
export const AnswerSchema = z.object({
  paragraphs: z.array(z.object({
    text: z.string().describe("One idea, in plain words. Precise names belong in evidence, not in every sentence"),
    label: z.enum(["confirmed", "inferred", "unknown", "record"]),
    evidence: z.array(Evidence),
    commit: z.string().describe("For 'record': the commit sha that records it; otherwise empty"),
    searched: z.string().describe("For a claim that something is absent or never happens: what you searched; otherwise empty"),
  })).describe("The answer, 1 to 5 short paragraphs"),
  scene: z.array(z.object({
    boxes: z.array(z.string()).describe("Box refs from the on-screen list, e.g. b3"),
    links: z.array(z.object({ from: z.string(), to: z.string() })).describe("Links from the on-screen list to animate, by box ref"),
    caption: z.string().describe("One short line (under 14 words) said while these light up"),
  })).describe("2 to 6 steps that show the answer on the canvas, in order. Empty if the boxes on screen can't show it"),
});
export type Answer = z.infer<typeof AnswerSchema>;
