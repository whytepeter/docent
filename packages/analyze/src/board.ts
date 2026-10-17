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
/** One move of the guide at the board: talk, point at lines, ask the question a newcomer would, answer it. */
const Beat = z.object({
  kind: z.enum(["say", "point", "ask", "reveal"]),
  text: z.string().describe("What Docent says, for the ear: one or two short sentences, under 30 words, no paths or code read aloud. ask: the question. reveal: the answer as you'd say it"),
  tone: z.enum(TONES).describe("calm (explaining, the default), warm (this part is solid), curious (a question), concerned (a risk), emphatic (the one thing to remember)"),
  lines: z.array(z.number().int()).describe("point and reveal: the 1 to 3 lines (absolute numbers inside this step's card excerpt) to mark while this is said. Otherwise []"),
  values: z.array(z.object({ line: z.number().int(), text: z.string().describe("Under 40 characters, e.g. 'file.size = 3 MB → passes', 'status 403 → expired'") }))
    .describe("point and reveal: what the intro's example request holds at these lines as it passes, written beside them. Only values that follow from the example and the code; otherwise []"),
  claim: Claim.nullable().describe("reveal only: what the answer asserts, with evidence; the spoken text must not say more. Otherwise null"),
});
const Hop = z.object({
  edge: z.string().describe("'from>to' card ids"),
  back: z.boolean().describe("True when it travels back along the edge (a reply)"),
  stat: z.string().describe("Short status shown on the card it reaches, e.g. '403 expired', 'row saved'"),
  tone: z.enum(["ok", "bad", "neutral"]),
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
    part: z.enum(["intro", "flow", "fail", "why", "close"]),
    card: z.string().describe("Card id this step is about (for fail: where it goes wrong), or empty for intro and close"),
    route: z.array(z.string()).describe("flow: edges the request travels to reach this card, as 'from>to' card ids. Otherwise []"),
    hops: z.array(Hop).describe("fail: the path the request takes when it goes wrong, the last hop 'bad'. Otherwise []"),
    beats: z.array(Beat).describe("2 to 5 beats, in the order they happen"),
  })).describe("In order: intro; one flow step per card; 1 to 3 fail steps; 1 to 3 why steps; close"),
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
  kind: "say" | "point" | "ask" | "reveal";
  text: string;
  tone: BeatTone;
  /** point and reveal: lines marked while it's said. */
  lines: number[];
  /** What the example request holds at some of those lines, written beside them. */
  values: { line: number; text: string }[];
  /** reveal only. */
  claim: AnalysisClaim | null;
}
export type Hop = z.infer<typeof Hop>;
export interface BoardStep {
  /** intro and close have no card; flow follows the request; fail shows it going wrong; why answers a reviewer. */
  part: "intro" | "flow" | "fail" | "why" | "close";
  card: string;
  route: string[];
  hops: Hop[];
  beats: Beat[];
}

export interface Board {
  /** 3: one tour (intro, flow, fail, why, close). Older boards are upgraded on load. */
  version: 3;
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
  notes: string[];
}

const BOARD_SYSTEM = `You are Docent, taking a developer through one flow of a codebase they didn't write, the way a senior engineer would at a real whiteboard. It replaces reading the READMEs: they watch and listen, they aren't tested. They should come away able to say what it does, follow a request through it, know what happens when it goes wrong, and know why it's built this way.

The code of the flow's files is below the facts, with line numbers: work from it, and use your read-only tools only for other files the flow really needs. Then build the board:
- 3 to 6 cards, one per part the request passes through, in order. Each card shows a real excerpt of a file: give the file and the line range (8–20 lines that matter); Docent cuts the code from the file itself.
- Edges between cards with what travels along them.
- The tour is the whole board. Its steps, in order:
  - intro (no card): one concrete situation, a real-looking request with plausible values, and the question the tour answers.
  - flow: one step per card, following that same request (route = the edges it travels to get there). Say why the part exists (the problem it solves) before how it works.
  - fail: 1 to 3 steps on what goes wrong that matters (an expired link, storage refusing, a stall). hops = the path the request takes, with the status each card shows, the last one bad. Say what the user sees and which code decides it.
  - why: 1 to 3 steps on the design choices a reviewer would question ("Why retry only on 401/403?"). Ask it, answer it with evidence, and say what would break without it.
  - close (no card): tie it together in the one sentence they can say out loud.
- Each step is a few beats:
  - say: Docent talks.
  - point: Docent talks while marking 1 to 3 exact lines on the card, like a hand on the whiteboard. Every flow step points at least once, at the lines that do the work.
  - ask: a question a newcomer would be wondering right now. Docent asks it and answers it itself in the very next beat (a reveal); nobody is quizzed. Use a few, where they help, not on every step.
  - reveal: the answer, with a claim and evidence, marking the lines it rests on.
- Make it a trace of the example, not a reading of the code: on point and reveal beats, give values for what the example request holds at those lines as it passes ("file.size = 3 MB → passes", "attempt = 2", "status 403 → expired"). Only what follows from the example and the code.
- Talk like a senior engineer at a whiteboard: "you", short sentences, callbacks to earlier steps ("remember the token from the first card?"), the occasional opinion ("this is the clever bit"). Never theatrical. Spoken text is for the ear: no paths or code read aloud.

Every claim (why, say, reveals) carries a label and evidence: file, start line, end line, and mentions (identifiers or short exact snippets in those lines). A script checks them and a second reader tries to refute every confirmed claim. "confirmed" = read in the code; "inferred" = a reasoned guess; "unknown" = can't tell from this repo; "record" = a commit says so (give the sha). Never invent a reason: if nothing records why, say so. Use only files that exist.`;

/** Writes a board in one Claude pass, then makes it mechanically sound. Claims are checked separately (checkBoard). */
export async function writeBoard(llm: LlmProvider, facts: Facts, root: string, flow: Flow, { signal }: { signal?: AbortSignal } = {}): Promise<Board> {
  const prompt = [
    `Flow: ${flow.title} — ${flow.summary}`,
    `Starts at: ${flow.entry}`,
    `Files it runs through: ${flow.files.join(", ")}`,
    "",
    featureDigest(facts, flow.files),
    "",
    flowSource(root, flow.files),
  ].join("\n");
  const result = await llm.ask({ system: BOARD_SYSTEM, prompt, schema: BoardSchema, tools: llm.id === "claude-code" ? "read" : "none", cwd: root, effort: "medium", signal });
  // The citation check is mechanical and instant, so it runs before the board is shown; the second reader runs behind it.
  return citeBoard(cleanBoard(result.data, facts, root, flow.id, result.model), facts, root);
}

const FILE_LINES = 700;
const SOURCE_CHARS = 150_000;

/**
 * The flow's own files, numbered, so the writer starts with the code in hand instead of opening each file
 * with a tool call. Long files are cut (and say so); the writer can still read the rest.
 */
function flowSource(root: string, files: string[]): string {
  const out = ["The code of the flow's files (line numbers are real; cite them):"];
  let used = 0;
  for (const f of files) {
    let lines: string[];
    try {
      lines = readFileSync(join(root, f), "utf8").split("\n");
    } catch {
      continue;
    }
    const shown = lines.slice(0, FILE_LINES).map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n");
    if (used + shown.length > SOURCE_CHARS) {
      out.push("", `=== ${f} (${lines.length} lines) — not included, too much code already; read it if you need it`);
      continue;
    }
    used += shown.length;
    out.push("", `=== ${f} (${lines.length} lines)`, shown);
    if (lines.length > FILE_LINES) out.push(`… cut at line ${FILE_LINES} of ${lines.length}; read the file for the rest`);
  }
  return out.join("\n");
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
    steps: board.steps.map((s) => ({ ...s, beats: s.beats.map((bt) => (bt.claim ? { ...bt, claim: next() } : bt)) })),
  };
}

type RawClaim = BoardSpec["cards"][number]["why"];
/** A claim straight from Claude, before the citation check fills in each evidence's result. */
const pending = (c: RawClaim, kind: AnalysisClaim["kind"]): AnalysisClaim => ({ ...c, kind, evidence: c.evidence.map((e) => ({ ...e, check: { ok: false, reason: "not checked yet" } })) });

/**
 * The mechanical clean-up: cards must show real files, excerpts are cut from those files, and every edge,
 * route, hop and marked line must point at things that exist. What's dropped is listed in `notes`.
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
  return {
    version: 3, flowId, generatedAt: new Date().toISOString(), model, status: "checking",
    title: spec.title, intro: spec.intro, pitch: spec.pitch, cards, edges, steps, notes,
  };
}

/**
 * A tour step made sound: marked lines must be on its card (a point with none just talks), a reveal needs a
 * claim, a fail step needs hops that run along real edges, and a fail or why step needs a card.
 */
function cleanStep(s: BoardSpec["steps"][number], card: BoardCard | undefined, edgeKeys: Set<string>, note: (m: string) => void): BoardStep {
  const onCard = (n: number) => !!card && n >= card.start && n < card.start + card.lines.length;
  const beats = s.beats.flatMap((b): Beat[] => {
    const text = b.text.trim();
    const lines = b.lines.filter(onCard);
    const base = { text, tone: b.tone, lines: [] as number[], values: [] as Beat["values"], claim: null };
    const values = b.values.filter((v) => onCard(v.line) && v.text.trim()).map((v) => ({ line: v.line, text: v.text.trim().slice(0, 48) })).slice(0, 4);
    if (b.kind === "reveal") {
      if (b.claim) return [{ ...base, kind: "reveal", text: text || b.claim.text, lines, values, claim: pending(b.claim, "behavior") }];
      note("a reveal without a claim is said instead");
    }
    if (!text) return [];
    if (b.kind === "point") {
      if (lines.length) return [{ ...base, kind: "point", lines, values }];
      note("a point at lines that aren't on its card is said instead");
    }
    if (b.kind === "ask") return [{ ...base, kind: "ask", tone: "curious" }];
    return [{ ...base, kind: "say" }];
  });
  const hops = s.hops.filter((h) => edgeKeys.has(h.edge));
  let part = s.part;
  if ((part === "fail" && !hops.length) || ((part === "fail" || part === "why") && !card)) {
    note(`a ${part} step without ${card ? "a path along the board's links" : "a card"} is told as a plain step`);
    part = card ? "flow" : "close";
  }
  return { part, card: card?.id ?? "", route: part === "flow" ? s.route.filter((r) => edgeKeys.has(r)) : [], hops: part === "fail" ? hops : [], beats };
}

type OldBeat = { kind: string; text: string; tone?: BeatTone; lines?: number[]; claim?: AnalysisClaim | null };
type OldHop = Hop;
type OldBoard = Omit<Board, "version" | "steps"> & {
  version: 1 | 2;
  steps: { card: string; route: string[]; text?: string; beats?: OldBeat[] }[];
  tryIt?: { scenarios: { label: string; hops: OldHop[]; result: AnalysisClaim }[] };
  defend?: { q: string; card: string; lines: number[]; answer: AnalysisClaim; breaks: string }[];
};

/**
 * Boards written before the single tour. Their steps keep what was said (a guess becomes a question
 * Docent answers itself); the failure scenarios become "what goes wrong" steps and the first reviewer
 * questions become "why it's built this way" steps, with their checked claims. Switches are dropped.
 */
export function upgradeBoard(raw: Board | OldBoard): Board {
  if (raw.version === 3) return raw;
  const b = raw as OldBoard;
  const n = b.steps.length;
  const steps: BoardStep[] = b.steps.map((s, i) => {
    const beats: Beat[] = (s.beats ?? [{ kind: "say", text: s.text ?? "" }]).map((bt) => ({
      kind: bt.kind === "predict" ? "ask" : (bt.kind as Beat["kind"]),
      text: bt.text,
      tone: bt.kind === "predict" || /\?\s*$/.test(bt.text) ? "curious" : bt.tone ?? "calm",
      lines: bt.kind === "predict" ? [] : bt.lines ?? [],
      values: [],
      claim: bt.claim ?? null,
    }));
    // A guess answered by pointing: its lines belong to the answer now.
    (s.beats ?? []).forEach((bt, k) => {
      const next = beats[k + 1];
      if (bt.kind === "predict" && bt.lines?.length && next?.kind === "reveal" && !next.lines.length) next.lines = bt.lines;
    });
    const part = s.card ? "flow" : i === 0 ? "intro" : i === n - 1 ? "close" : "flow";
    return { part, card: s.card, route: s.route, hops: [], beats };
  });
  const cardOf = (h: OldHop) => {
    const [a, c] = h.edge.split(">");
    return (h.back ? a : c) ?? "";
  };
  const fails: BoardStep[] = (b.tryIt?.scenarios ?? []).slice(1, 4).filter((sc) => sc.hops.length).map((sc) => ({
    part: "fail", card: cardOf(sc.hops[sc.hops.length - 1]!), route: [], hops: sc.hops,
    beats: [
      // Old scenario labels are button text ("Storage refuses", "PNG front, JPEG back"), so they're set up, not asked.
      { kind: "say", text: `Here's one that goes wrong: ${sc.label}.`, tone: "concerned", lines: [], values: [], claim: null },
      { kind: "reveal", text: sc.result.text, tone: "concerned", lines: [], values: [], claim: sc.result },
    ],
  }));
  const whys: BoardStep[] = (b.defend ?? []).filter((d) => d.card).slice(0, 3).map((d) => ({
    part: "why", card: d.card, route: [], hops: [],
    beats: [
      { kind: "ask", text: d.q, tone: "curious", lines: [], values: [], claim: null },
      { kind: "reveal", text: d.answer.text, tone: "calm", lines: d.lines, values: [], claim: d.answer },
      ...(d.breaks ? [{ kind: "say" as const, text: `Without it: ${d.breaks}`, tone: "concerned" as const, lines: [], values: [], claim: null }] : []),
    ],
  }));
  const close = steps.length && steps[steps.length - 1]!.part === "close" ? steps.splice(-1) : [];
  const { tryIt: _t, defend: _d, ...rest } = b;
  return { ...rest, version: 3, steps: [...steps, ...fails, ...whys, ...close] };
}

/** Every claim on a board, in a fixed order, so checked versions can be put back in place. */
function claimsOf(b: Board): AnalysisClaim[] {
  return [
    ...b.cards.flatMap((c) => [c.why, c.say]),
    ...b.steps.flatMap((s) => s.beats.flatMap((bt) => (bt.claim ? [bt.claim] : []))),
  ];
}

/** Behind the board: the second reader tries to refute every confirmed and record claim. Labels settle. */
export async function checkBoard(llm: LlmProvider, facts: Facts, root: string, board: Board, { signal }: { signal?: AbortSignal } = {}): Promise<Board> {
  const reviewed = await refuteClaims(llm, facts, root, claimsOf(board), signal);
  return { ...putClaims(board, reviewed), status: "checked" };
}
