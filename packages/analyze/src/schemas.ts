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

const Claim = z.object({
  text: z.string().describe("The claim in plain words: what is true in the code"),
  label: z.enum(["confirmed", "inferred", "unknown", "record"]),
  evidence: z.array(Evidence),
  commit: z.string().describe("For 'record': the commit sha; otherwise empty"),
  searched: z.string().describe("For a claim of absence: what you searched; otherwise empty"),
});

/** A narrated, animated lesson for one feature. One fixed player renders any episode that fits this (P6). */
export const EpisodeSchema = z.object({
  title: z.string().describe("A plain title a newcomer understands"),
  intro: z.string().describe("Two sentences: what this feature does for the user, and why it matters to the developer. No file names"),
  analogy: z.string().describe("One everyday analogy for the whole feature, before any code names"),
  cast: z.array(z.object({
    id: z.string().describe("kebab-case id used by links and steps"),
    title: z.string().describe("Plain name, e.g. 'Upload screen', 'Send the files', 'File storage'"),
    kind: z.enum(["screen", "code", "service", "external", "data"]),
    lane: z.number().int().describe("Column, left to right in the order things happen: 0 = where the user acts, higher = further along"),
    file: z.string().describe("Repo file this box stands for; empty only for something outside the repo"),
    symbol: z.string().describe("Symbol id from the facts (path#Name) when the box is one function or component; otherwise empty"),
    start: z.number().int().describe("First line of the code the box stands for, or 0"),
    end: z.number().int().describe("Last line, or 0"),
  })).describe("3 to 8 boxes. Fewer boxes that mean something beat more boxes that are merely accurate"),
  links: z.array(z.object({ id: z.string(), from: z.string(), to: z.string(), label: z.string().describe("What travels along it, in a few words") })),
  scenes: z.array(z.object({
    title: z.string(),
    objective: z.string().describe("The one idea this scene teaches"),
    steps: z.array(z.object({
      boxes: z.array(z.string()).describe("Cast ids lit in this step"),
      links: z.array(z.string()).describe("Link ids animated in this step"),
      packets: z.array(z.object({
        link: z.string(),
        label: z.string().describe("What moves, in 1 to 4 words, e.g. 'front photo', 'signed targets'"),
        back: z.boolean().describe("True when it travels against the link's direction (a reply)"),
        bad: z.boolean().describe("True for an error or refusal"),
      })),
      code: z.object({ file: z.string(), start: z.number().int(), end: z.number().int() }).describe("The lines the code panel shows; file empty for none"),
      say: z.string().describe("Narration for the ear, about 35 words, 10 to 15 seconds. No file paths, symbols or code read aloud"),
      tone: z.enum(["calm", "warm", "curious", "concerned", "emphatic"]).describe("How the narrator says it: calm (explaining, the default), warm (this part is solid), curious (a question), concerned (a risk, something not to trust), emphatic (the point to remember). Mostly calm; match the words"),
      caption: z.string().describe("Short on-screen text. Precise names belong here"),
      claim: Claim.describe("What this step asserts, with evidence. The narration must not say more than this claim"),
      predict: z.object({
        question: z.string(),
        options: z.array(z.object({ text: z.string(), correct: z.boolean() })),
        reveal: Claim.describe("The answer, explained, with evidence"),
      }).nullable().describe("Pause and ask the learner to predict before showing; at most one or two per episode, else null"),
    })).describe("1 to 4 steps"),
  })).describe("4 to 7 scenes: start where the user acts, follow the main flow, then one scene on what can go wrong and where to look"),
  selfCheck: z.array(z.object({ question: z.string(), answer: Claim })).describe("Exactly the five ownership questions, answered for this feature"),
  exercise: z.object({
    task: z.string().describe("A small change the learner makes in the real repo, by hand"),
    hint: z.string(),
    check: z.string().describe("How they know they got it right: a test command to run, or what to observe"),
  }),
});
export type EpisodeSpec = z.infer<typeof EpisodeSchema>;
