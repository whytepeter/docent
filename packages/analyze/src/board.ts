import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Facts } from "@docent/extract";
import { redact, z, type LlmProvider } from "@docent/llm";
import { makeChecker } from "./citations.ts";
import { discoveryDigest, featureDigest } from "./digest.ts";
import { refuteClaims } from "./refute.ts";
import type { AnalysisClaim } from "./types.ts";

/*
 * Boards: one whiteboard per flow ("how an ID upload works"). Fast by design: one Claude pass proposes
 * flows, one pass writes a board. Code on the board is cut from the real files (never written by Claude);
 * claims are checked behind the board, so it shows in minutes and its labels firm up a minute later.
 */

// ---------------------------------------------------------------- flows

const FlowsSchema = z.object({
  flows: z.array(z.object({
    id: z.string().describe("kebab-case, e.g. upload-id-document"),
    title: z.string().describe("What a person would call it, e.g. 'Upload an ID document'"),
    summary: z.string().describe("One plain sentence: what happens, from the user's action to the result"),
    entry: z.string().describe("Where it starts: a symbol id (path#Name) or file path from the facts"),
    files: z.array(z.string()).describe("The 3 to 8 files the flow runs through, in order"),
  })).describe("4 to 8 flows a newcomer would want explained, the most important first"),
});

export interface Flow {
  id: string;
  title: string;
  summary: string;
  entry: string;
  files: string[];
}

export interface FlowList {
  version: 1;
  generatedAt: string;
  model: string;
  flows: Flow[];
}

const FLOWS_SYSTEM = `You are Docent. A developer is seeing this codebase for the first time. From the facts below, pick the 4 to 8 flows most worth a whiteboard explanation: things a user or operator does ("Upload an ID document", "Start a verification session"), each running through a few files from the user's action to the result. Most important first. Use only file paths and symbol ids that appear in the facts.`;

export async function proposeFlows(llm: LlmProvider, facts: Facts, { signal }: { signal?: AbortSignal } = {}): Promise<FlowList> {
  const result = await llm.ask({ system: FLOWS_SYSTEM, prompt: discoveryDigest(facts), schema: FlowsSchema, tools: "none", effort: "low", signal });
  const files = new Set(facts.files.map((f) => f.path));
  const seen = new Set<string>();
  const flows = result.data.flows
    .map((f) => ({ ...f, id: kebab(f.id || f.title), files: f.files.filter((p) => files.has(p)) }))
    .filter((f) => f.files.length && !seen.has(f.id) && (seen.add(f.id), true));
  return { version: 1, generatedAt: new Date().toISOString(), model: result.model, flows };
}

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "flow";

// ---------------------------------------------------------------- boards

const Evidence = z.object({ file: z.string(), start: z.number().int(), end: z.number().int(), mentions: z.array(z.string()) });
export const Claim = z.object({
  text: z.string(),
  label: z.enum(["confirmed", "inferred", "unknown", "record"]),
  evidence: z.array(Evidence).describe("Lines that prove it; mentions = identifiers or short exact snippets in those lines"),
  commit: z.string().describe("For 'record': the commit sha; otherwise empty"),
  searched: z.string().describe("For a claim that something never happens: what you searched; otherwise empty"),
});

const TONES = ["calm", "warm", "curious", "concerned", "emphatic"] as const;
/** One move of the teacher at the board: talk, point at lines, ask the learner to guess, give the answer. */
const Beat = z.object({
  kind: z.enum(["say", "point", "predict", "reveal"]),
  text: z.string().describe("What Docent says, for the ear: one or two short sentences, under 30 words, no paths or code read aloud. predict: the question. reveal: the answer as you'd say it"),
  tone: z.enum(TONES).describe("calm (explaining, the default), warm (this part is solid), curious (a question), concerned (a risk), emphatic (the one thing to remember)"),
  lines: z.array(z.number().int()).describe("point: the 1 to 3 lines (absolute numbers inside this step's card excerpt) to mark while this is said. predict answered by pointing: the lines where the answer is. Otherwise []"),
  choices: z.array(z.object({ text: z.string().describe("A short answer, under 12 words"), correct: z.boolean() })).describe("predict only: 2 or 3 answers, exactly one correct; or [] to have the learner click the lines instead. Otherwise []"),
  claim: Claim.nullable().describe("reveal only: what the reveal asserts, with evidence; the spoken text must not say more. Otherwise null"),
});

const BoardSchema = z.object({
  title: z.string().describe("A plain title, e.g. 'How an ID upload works'"),
  intro: z.string().describe("Two plain sentences for the big-picture step"),
  pitch: z.string().describe("A 30-second pitch the developer could say out loud, in plain words"),
  cards: z.array(z.object({
    id: z.string().describe("kebab-case"),
    title: z.string().describe("Plain name of the part: 'Upload screen', 'Send the files', 'File storage'"),
    file: z.string().describe("Repo file this card shows"),
    start: z.number().int().describe("First line of the excerpt"),
    end: z.number().int().describe("Last line of the excerpt; keep excerpts to 8–20 lines that matter"),
    hot: z.array(z.number().int()).describe("Line numbers (absolute, inside the excerpt) to highlight on the tour"),
    role: z.string().describe("One sentence: what this part does in the flow"),
    why: Claim.describe("Why it's built this way, from the code or a commit; or say no reason is recorded"),
    say: Claim.describe("One sentence the developer could say about this part"),
  })).describe("3 to 6 cards, in the order the flow runs. Fewer cards that matter beat more that are merely accurate"),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().describe("What travels, in 2–4 words, e.g. 'POST /upload'") })),
  steps: z.array(z.object({
    card: z.string().describe("Card id this step is about, or empty for a big-picture step"),
    route: z.array(z.string()).describe("Edges the packet travels before this step, as 'from>to' card ids"),
    beats: z.array(Beat).describe("2 to 5 beats, in the order they happen"),
  })).describe("5 to 8 steps: a big picture first, one per card following the request, and a last 'now you can say it' step"),
  tryIt: z.object({
    intro: z.string().describe("One line inviting the developer to try the flow and break it"),
    scenarios: z.array(z.object({
      id: z.string(),
      label: z.string().describe("Button text, e.g. 'Send a valid upload', 'Storage refuses'"),
      hops: z.array(z.object({
        edge: z.string().describe("'from>to' card ids"),
        back: z.boolean().describe("True when it travels back along the edge (a reply)"),
        stat: z.string().describe("Short status shown on the card it reaches, e.g. '403 expired', 'row saved'"),
        tone: z.enum(["ok", "bad", "neutral"]),
      })),
      result: Claim.describe("What just happened, in plain words, with evidence"),
    })).describe("2 to 4 scenarios: the happy path first, then the failures that matter"),
    toggles: z.array(z.object({
      id: z.string(),
      label: z.string().describe("Switch label, e.g. 'Retry an expired link'"),
      detail: z.string().describe("Small line under it: what turning it off means"),
      card: z.string().describe("Card whose code changes"),
      line: z.number().int().describe("Absolute line number in that card's excerpt that changes"),
      off: z.string().describe("What that line becomes when the switch is off (a plausible broken version)"),
      scenario: z.string().describe("Scenario id to run to see the effect"),
      offHops: z.array(z.object({
        edge: z.string(),
        back: z.boolean(),
        stat: z.string(),
        tone: z.enum(["ok", "bad", "neutral"]),
      })).describe("How that scenario goes with the switch off: the hops until it fails (no hops for the safety that's now missing)"),
      result: Claim.describe("What happens with it off, with evidence for why the real line matters"),
    })).describe("0 to 3 switches that remove a safety; only where the effect is clear from the code"),
  }),
  defend: z.array(z.object({
    q: z.string().describe("A question a reviewer would ask, e.g. 'Why retry only on 401/403?'"),
    short: z.string().describe("2–4 word label"),
    answer: Claim,
    card: z.string().describe("Card whose lines back the answer"),
    lines: z.array(z.number().int()).describe("Absolute line numbers in that card's excerpt"),
    pushQ: z.string().describe("The follow-up if they push"),
    pushA: z.string(),
    breaks: z.string().describe("What breaks without it"),
  })).describe("Exactly 6 questions, the most important first"),
});
type BoardSpec = z.infer<typeof BoardSchema>;

export interface BoardCard {
  id: string;
  n: number;
  title: string;
  file: string;
  start: number;
  /** The excerpt, cut from the file at write time (redacted). */
  lines: string[];
  hot: number[];
  role: string;
  why: AnalysisClaim;
  say: AnalysisClaim;
}

export type BeatTone = (typeof TONES)[number];
export interface Beat {
  kind: "say" | "point" | "predict" | "reveal";
  text: string;
  tone: BeatTone;
  /** point: lines marked while it's said. predict without choices: the lines that answer it. */
  lines: number[];
  choices: { text: string; correct: boolean }[];
  /** reveal only. */
  claim: AnalysisClaim | null;
}
export interface BoardStep {
  card: string;
  route: string[];
  beats: Beat[];
}

export interface Board {
  /** 2: tour steps are beats (say, point, predict, reveal). 1: one narration per step, upgraded on load. */
  version: 1 | 2;
  flowId: string;
  generatedAt: string;
  model: string;
  /** "checking" while the citation check and second reader run behind the board; then "checked". */
  status: "checking" | "checked";
  title: string;
  intro: string;
  pitch: string;
  cards: BoardCard[];
  edges: BoardSpec["edges"];
  steps: BoardStep[];
  tryIt: {
    intro: string;
    scenarios: (Omit<BoardSpec["tryIt"]["scenarios"][number], "result"> & { result: AnalysisClaim })[];
    toggles: (Omit<BoardSpec["tryIt"]["toggles"][number], "result"> & { original: string; result: AnalysisClaim })[];
  };
  defend: (Omit<BoardSpec["defend"][number], "answer"> & { answer: AnalysisClaim })[];
  notes: string[];
}

const BOARD_SYSTEM = `You are Docent, making a whiteboard that explains one flow of a codebase to a developer seeing it for the first time, the way a senior engineer would at a real whiteboard. They should come away able to say what it does, follow a request through it, and defend the design.

Read the code (you have read-only tools) and build the board:
- 3 to 6 cards, one per part the request passes through, in order. Each card shows a real excerpt of a file: give the file and the line range (8–20 lines that matter); Docent cuts the code from the file itself.
- Edges between cards with what travels along them.
- The tour: teach it, don't read it out. Steps follow the request (a big picture, one step per card, then "now you can say it"); each step is a few beats:
  - say: Docent talks.
  - point: Docent talks while marking 1 to 3 exact lines on the card, like a hand on the whiteboard. Every card step points at least once, at the lines that do the work.
  - predict: Docent stops and asks the learner to guess before showing: what happens next, what a line is for, what goes wrong without it. They pick from 2 or 3 answers, or click the line where it happens. Ask where a newcomer would guess wrong, never trivia.
  - reveal: right after each predict, the answer, with a claim and evidence.
- Shape the lesson. The first step (no card) sets up one concrete situation, a real-looking request with plausible values, and the question the tour answers. Follow that same request through every card. Each card step says why the part exists (the problem it solves) before how it works. Use 3 or 4 predicts across the tour, on the moments that matter most: a guard, a retry, a surprising order, a failure. The last step (no card) ties it together in the one sentence they can say out loud.
- Talk like a senior engineer at a whiteboard: "you", short sentences, callbacks to earlier steps ("remember the token from the first card?"), the occasional opinion ("this is the clever bit"). Never theatrical. Spoken text is for the ear: no paths or code read aloud.
- Try it: scenarios as packet hops between cards, with the status each card shows; switches that turn off a real safety line and the scenario that shows why it matters.
- Defend it: exactly 6 questions a reviewer would ask, with the answer, the follow-up if they push, and what breaks without it.

Every claim (why, say, results, answers) carries a label and evidence: file, start line, end line, and mentions (identifiers or short exact snippets in those lines). A script checks them and a second reader tries to refute every confirmed claim. "confirmed" = read in the code; "inferred" = a reasoned guess; "unknown" = can't tell from this repo; "record" = a commit says so (give the sha). Never invent a reason: if nothing records why, say so. Use only files that exist.`;

/** Writes a board in one Claude pass, then makes it mechanically sound. Claims are checked separately (checkBoard). */
export async function writeBoard(llm: LlmProvider, facts: Facts, root: string, flow: Flow, { signal }: { signal?: AbortSignal } = {}): Promise<Board> {
  const prompt = [
    `Flow: ${flow.title} — ${flow.summary}`,
    `Starts at: ${flow.entry}`,
    `Files it runs through: ${flow.files.join(", ")}`,
    "",
    featureDigest(facts, flow.files),
  ].join("\n");
  const result = await llm.ask({ system: BOARD_SYSTEM, prompt, schema: BoardSchema, tools: llm.id === "claude-code" ? "read" : "none", cwd: root, effort: "medium", signal });
  // The citation check is mechanical and instant, so it runs before the board is shown; the second reader runs behind it.
  return citeBoard(cleanBoard(result.data, facts, root, flow.id, result.model), facts, root);
}

/** Runs the citation check over every claim on the board (fast, no Claude). */
export function citeBoard(board: Board, facts: Facts, root: string): Board {
  const checked = makeChecker(root, facts).apply({ summary: "", analogy: "", status: "unknown", statusReason: "", flow: [], issues: [], claims: claimsOf(board).map(({ evidence, ...c }) => ({ ...c, evidence: evidence.map(({ check: _, ...e }) => e) })) }).claims;
  return putClaims(board, checked);
}

/** Puts claims back in the order claimsOf lists them. */
function putClaims(board: Board, claims: AnalysisClaim[]): Board {
  let i = 0;
  const next = () => claims[i++]!;
  return {
    ...board,
    cards: board.cards.map((c) => ({ ...c, why: next(), say: next() })),
    tryIt: { ...board.tryIt, scenarios: board.tryIt.scenarios.map((s) => ({ ...s, result: next() })), toggles: board.tryIt.toggles.map((t) => ({ ...t, result: next() })) },
    defend: board.defend.map((d) => ({ ...d, answer: next() })),
    steps: board.steps.map((s) => ({ ...s, beats: s.beats.map((bt) => (bt.claim ? { ...bt, claim: next() } : bt)) })),
  };
}

type RawClaim = BoardSpec["cards"][number]["why"];
/** A claim straight from Claude, before the citation check fills in each evidence's result. */
const pending = (c: RawClaim, kind: AnalysisClaim["kind"]): AnalysisClaim => ({ ...c, kind, evidence: c.evidence.map((e) => ({ ...e, check: { ok: false, reason: "not checked yet" } })) });

/**
 * The mechanical clean-up: cards must show real files, excerpts are cut from those files, and every edge,
 * route, hop, switch and question must point at things that exist. What's dropped is listed in `notes`.
 */
export function cleanBoard(spec: BoardSpec, facts: Facts, root: string, flowId: string, model: string): Board {
  const notes: string[] = [];
  const files = new Map(facts.files.map((f) => [f.path, f]));
  const text = new Map<string, string[]>();
  const read = (p: string) => {
    if (!text.has(p)) text.set(p, readFileSync(join(root, p), "utf8").split("\n"));
    return text.get(p)!;
  };
  const MAX = 26;
  const cards: BoardCard[] = [];
  for (const c of spec.cards) {
    const f = files.get(c.file);
    if (!f) {
      notes.push(`dropped card "${c.title}": ${c.file} isn't in the repo`);
      continue;
    }
    const all = read(c.file);
    const start = Math.max(1, Math.min(c.start, all.length));
    const end = Math.max(start, Math.min(c.end, all.length, start + MAX - 1));
    const lines = all.slice(start - 1, end).map((l) => redact(l));
    cards.push({
      id: kebab(c.id), n: cards.length + 1, title: c.title, file: c.file, start, lines,
      hot: c.hot.filter((h) => h >= start && h <= end), role: c.role,
      why: pending(c.why, "why"), say: pending(c.say, "behavior"),
    });
  }
  const ids = new Set(cards.map((c) => c.id));
  const edges = spec.edges.map((e) => ({ ...e, from: kebab(e.from), to: kebab(e.to) })).filter((e) => (ids.has(e.from) && ids.has(e.to)) || (notes.push(`dropped edge ${e.from}>${e.to}`), false));
  const edgeKeys = new Set(edges.map((e) => `${e.from}>${e.to}`));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const steps = spec.steps.map((s, n) => cleanStep(s, byId.get(kebab(s.card)), edgeKeys, (m) => notes.push(`step ${n + 1}: ${m}`))).filter((s) => s.beats.length);
  const scenarios = spec.tryIt.scenarios.map((s) => ({ ...s, hops: s.hops.filter((h) => edgeKeys.has(h.edge)), result: pending(s.result, "behavior") })).filter((s) => s.hops.length);
  const scenarioIds = new Set(scenarios.map((s) => s.id));
  const toggles = spec.tryIt.toggles.flatMap((t) => {
    const card = byId.get(kebab(t.card));
    const original = card?.lines[t.line - (card?.start ?? 0)];
    if (!card || original === undefined || !scenarioIds.has(t.scenario)) return (notes.push(`dropped switch "${t.label}"`), []);
    return [{ ...t, card: card.id, off: redact(t.off), original, offHops: t.offHops.filter((h) => edgeKeys.has(h.edge)), result: pending(t.result, "risk") }];
  });
  const defend = spec.defend.map((d) => {
    const card = byId.get(kebab(d.card));
    return { ...d, card: card?.id ?? "", lines: card ? d.lines.filter((n) => n >= card.start && n < card.start + card.lines.length) : [], answer: pending(d.answer, "behavior") };
  });
  return {
    version: 2, flowId, generatedAt: new Date().toISOString(), model, status: "checking",
    title: spec.title, intro: spec.intro, pitch: spec.pitch, cards, edges, steps,
    tryIt: { intro: spec.tryIt.intro, scenarios, toggles }, defend, notes,
  };
}

/**
 * A tour step made sound: its lines must be on its card, a point with no lines just talks, a predict needs
 * either one right answer among its choices or lines to click (else it's asked and answered aloud), and a
 * reveal needs a claim.
 */
function cleanStep(s: BoardSpec["steps"][number], card: BoardCard | undefined, edgeKeys: Set<string>, note: (m: string) => void): BoardStep {
  const onCard = (n: number) => !!card && n >= card.start && n < card.start + card.lines.length;
  const beats = s.beats.flatMap((b): Beat[] => {
    const text = b.text.trim();
    const lines = b.lines.filter(onCard);
    const base = { text, tone: b.tone, lines: [] as number[], choices: [] as Beat["choices"], claim: null };
    if (b.kind === "reveal") {
      if (b.claim) return [{ ...base, kind: "reveal", text: text || b.claim.text, claim: pending(b.claim, "behavior") }];
      note("a reveal without a claim is said instead");
    }
    if (!text) return [];
    if (b.kind === "point") {
      if (lines.length) return [{ ...base, kind: "point", lines }];
      note("a point at lines that aren't on its card is said instead");
    }
    if (b.kind === "predict") {
      const choices = b.choices.filter((c) => c.text.trim()).slice(0, 4);
      if (choices.length >= 2 && choices.filter((c) => c.correct).length === 1) return [{ ...base, kind: "predict", choices: mix(choices, text) }];
      if (!choices.length && lines.length) return [{ ...base, kind: "predict", lines }];
      note("a predict with no clear answer is asked aloud instead");
    }
    return [{ ...base, kind: "say" }];
  });
  return { card: card?.id ?? "", route: s.route.filter((r) => edgeKeys.has(r)), beats };
}

/** Writers tend to put the right answer first; this moves it, the same way every time for the same question. */
function mix<T>(choices: T[], seed: string): T[] {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const k = h % choices.length;
  return [...choices.slice(k), ...choices.slice(0, k)];
}

/** Boards written before beats: each step's narration becomes one "say" beat. */
export function upgradeBoard(b: Board): Board {
  if (b.version === 2) return b;
  const steps = (b.steps as unknown as { card: string; route: string[]; text?: string; beats?: Beat[] }[]).map((s) => ({
    card: s.card,
    route: s.route,
    beats: s.beats ?? [{ kind: "say" as const, text: s.text ?? "", tone: (/\?\s*$/.test(s.text ?? "") ? "curious" : "calm") as BeatTone, lines: [], choices: [], claim: null }],
  }));
  return { ...b, version: 2, steps };
}

/** Every claim on a board, in a fixed order, so checked versions can be put back in place. */
function claimsOf(b: Board): AnalysisClaim[] {
  return [
    ...b.cards.flatMap((c) => [c.why, c.say]),
    ...b.tryIt.scenarios.map((s) => s.result),
    ...b.tryIt.toggles.map((t) => t.result),
    ...b.defend.map((d) => d.answer),
    ...b.steps.flatMap((s) => s.beats.flatMap((bt) => (bt.claim ? [bt.claim] : []))),
  ];
}

/** Behind the board: the second reader tries to refute every confirmed and record claim. Labels settle. */
export async function checkBoard(llm: LlmProvider, facts: Facts, root: string, board: Board, { signal }: { signal?: AbortSignal } = {}): Promise<Board> {
  const reviewed = await refuteClaims(llm, facts, root, claimsOf(board), signal);
  return { ...putClaims(board, reviewed), status: "checked" };
}
