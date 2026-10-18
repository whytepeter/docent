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
    .describe("point and reveal: what the intro's example request holds at these lines as it passes, written beside them. Write 'name = value' with a name that appears on that line, or a short outcome ('→ passes'). Only values that follow from the example and the code; otherwise []"),
  claim: Claim.nullable().describe("point and reveal: what this beat says about the code, with evidence on the lines it marks; the spoken text must not say more. say and ask: null"),
  analogy: z.boolean().describe("say only: true for the intro's everyday analogy, which is a picture and not a claim about the code. Otherwise false"),
});
const Held = z.object({
  key: z.string().describe("A name a newcomer would track, e.g. 'user._id', 'session', 'attempt'"),
  value: z.string().describe("Under 30 characters, e.g. '66a1…f3', 'open', '2 of 3'"),
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
    state: z.array(Held).describe("intro and flow: what the example holds once this step has run, 2 to 5 things worth tracking, carried forward from earlier steps (drop what stops mattering). Plain data the request carries (ids, flags, statuses), never a conclusion the step reveals. Otherwise []"),
  })).describe("In order: intro; one flow step per card; 1 to 3 fail steps; 1 to 3 why steps; close"),
  example: Claim.nullable().describe("Where the intro's example comes from: the test lines that build that request, with evidence. null when the example is made up"),
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
  /** point and reveal: what it says about the marked lines. A point the writer left unclaimed is an inferred guess. */
  claim: AnalysisClaim | null;
  /** say only: the intro's everyday analogy, a picture rather than a claim. */
  analogy: boolean;
}
/** Something the example holds once a step has run, and how it differs from the step before. */
export interface Held {
  key: string;
  value: string;
  change: "new" | "changed" | "same";
}
export type Hop = z.infer<typeof Hop>;
export interface BoardStep {
  /** intro and close have no card; flow follows the request; fail shows it going wrong; why answers a reviewer. */
  part: "intro" | "flow" | "fail" | "why" | "close";
  card: string;
  route: string[];
  hops: Hop[];
  beats: Beat[];
  /** intro and flow: what the example holds once this step has run. */
  state: Held[];
}

export interface Board {
  /** 4: one tour (intro, flow, fail, why, close) with labeled points and the example's state. Older boards are upgraded on load. */
  version: 4;
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
  /** Where the intro's example comes from (test lines), or null when it was made up. */
  example: AnalysisClaim | null;
  notes: string[];
}

const BOARD_SYSTEM = `You are Docent, taking a developer through one flow of a codebase they didn't write, the way a senior engineer would at a real whiteboard. It replaces reading the READMEs: they watch and listen, they aren't tested. They should come away able to say what it does, follow a request through it, know what happens when it goes wrong, and know why it's built this way.

The code of the flow's files is below the facts, with line numbers: work from it, and use your read-only tools only for other files the flow really needs. Then build the board:
- 3 to 6 cards, one per part the request passes through, in order. Each card shows a real excerpt of a file: give the file and the line range (8–20 lines that matter); Docent cuts the code from the file itself.
- Edges between cards with what travels along them.
- The tour is the whole board. Its steps, in order:
  - intro (no card): one concrete situation, a real-looking request, and the question the tour answers. If a test below builds such a request, use its values and cite those lines as the example; otherwise make up plausible values and set example to null. Then one everyday analogy for the whole flow, before any code names (a say beat with analogy true; "like posting a parcel: get a label, drop it at the depot, keep the receipt").
  - flow: one step per card, following that same request (route = the edges it travels to get there). Say why the part exists (the problem it solves) before how it works.
  - fail: 1 to 3 steps on what goes wrong that matters (an expired link, storage refusing, a stall). hops = the path the request takes, with the status each card shows, the last one bad. Say what the user sees and which code decides it.
  - why: 1 to 3 steps on the design choices a reviewer would question ("Why retry only on 401/403?"). Ask it, answer it with evidence, and say what would break without it.
  - close (no card): tie it together in the one sentence they can say out loud.
- Each step is a few beats:
  - say: Docent talks: sets the scene, connects one step to the next, explains a term. Anything about what the code does is a point or a reveal instead, so it carries a claim.
  - point: Docent talks while marking 1 to 3 exact lines on the card, like a hand on the whiteboard, with a claim: what was said about those lines, with evidence on them. Every flow step points at least once, at the lines that do the work.
  - ask: a question a newcomer would be wondering right now. Docent asks it and answers it itself in the very next beat (a reveal); nobody is quizzed. Use a few, where they help, not on every step.
  - reveal: the answer, with a claim and evidence, marking the lines it rests on.
- Make it a trace of the example, not a reading of the code: on point and reveal beats, give values for what the example request holds at those lines as it passes ("file.size = 3 MB → passes", "attempt = 2", "status 403 → expired"). Only what follows from the example and the code.
- Keep the example's state: on intro and each flow step, list the few things it holds once that step has run (an id it was given, a flag, a status), carried forward, so the newcomer sees it build up from card to card.
- The first time a framework or domain term comes up (a transaction, a presigned URL, an idempotency key, a decorator), say what it is in one plain sentence.
- Talk like a senior engineer at a whiteboard: "you", short sentences, callbacks to earlier steps ("remember the token from the first card?"), the occasional opinion ("this is the clever bit"). Never theatrical. Spoken text is for the ear: no paths or code read aloud.

Every claim (why, say, points, reveals, the example) carries a label and evidence: file, start line, end line, and mentions (identifiers or short exact snippets in those lines). A script checks them and a second reader tries to refute every confirmed claim. "confirmed" = read in the code; "inferred" = a reasoned guess; "unknown" = can't tell from this repo; "record" = a commit says so (give the sha). Never invent a reason: if nothing records why, say so. Use only files that exist.`;

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
    "",
    flowSource(root, flowTests(facts, flow.files), "Tests that exercise the flow (line numbers are real; if one builds a request, it can be the intro's example):", TEST_LINES, TEST_CHARS),
  ].join("\n");
  const result = await llm.ask({ system: BOARD_SYSTEM, prompt, schema: BoardSchema, tools: llm.canRead ? "read" : "none", cwd: root, effort: "medium", signal });
  // The citation check is mechanical and instant, so it runs before the board is shown; the second reader runs behind it.
  return citeBoard(cleanBoard(result.data, facts, root, flow.id, result.model), facts, root);
}

const FILE_LINES = 700;
const SOURCE_CHARS = 150_000;
const TEST_FILES = 2;
const TEST_LINES = 300;
const TEST_CHARS = 30_000;

/** The test files that reach the flow's files, those with the most links first, so the example can come from a real test. */
export function flowTests(facts: Facts, files: string[]): string[] {
  const set = new Set(files);
  const links = new Map<string, number>();
  for (const e of facts.edges) {
    if (!e.from.includes("#test:") || !set.has(e.to.split("#")[0]!)) continue;
    const t = e.from.split("#")[0]!;
    links.set(t, (links.get(t) ?? 0) + 1);
  }
  return [...links].sort((a, b) => b[1] - a[1]).slice(0, TEST_FILES).map(([t]) => t);
}

/**
 * The flow's own files, numbered, so the writer starts with the code in hand instead of opening each file
 * with a tool call. Long files are cut (and say so); the writer can still read the rest.
 */
function flowSource(root: string, files: string[], title = "The code of the flow's files (line numbers are real; cite them):", maxLines = FILE_LINES, maxChars = SOURCE_CHARS): string {
  if (!files.length) return "";
  const out = [title];
  let used = 0;
  for (const f of files) {
    let lines: string[];
    try {
      lines = readFileSync(join(root, f), "utf8").split("\n");
    } catch {
      continue;
    }
    const shown = lines.slice(0, maxLines).map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n");
    if (used + shown.length > maxChars) {
      out.push("", `=== ${f} (${lines.length} lines) — not included, too much code already; read it if you need it`);
      continue;
    }
    used += shown.length;
    out.push("", `=== ${f} (${lines.length} lines)`, shown);
    if (lines.length > maxLines) out.push(`… cut at line ${maxLines} of ${lines.length}; read the file for the rest`);
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
    example: board.example ? next() : null,
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
  // What the example holds builds up from the intro through the flow; each thing is marked new, changed or the same.
  let before = new Map<string, string>();
  for (const s of steps) {
    if (s.part !== "intro" && s.part !== "flow") continue;
    s.state = s.state.map((h) => ({ ...h, change: !before.has(h.key) ? "new" : before.get(h.key) === h.value ? "same" : "changed" }));
    before = new Map(s.state.map((h) => [h.key, h.value]));
  }
  return {
    version: 4, flowId, generatedAt: new Date().toISOString(), model, status: "checking",
    title: spec.title, intro: spec.intro, pitch: spec.pitch, cards, edges, steps,
    example: spec.example ? pending(spec.example, "behavior") : null, notes,
  };
}

/**
 * Whether a value written beside a line belongs there: "name = value" needs the line to mention the name (one
 * part of a dotted name, inside a longer identifier too: status in setStatus, artifactType as artifact_type) or
 * the value itself ("selfie.jpg"). An outcome without a name ("→ passes", "transaction open") is taken as written.
 */
export function valueFits(text: string, line: string): boolean {
  const m = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\[[^\]]*\])?\s*=(?![=>])\s*(.*)$/.exec(text);
  if (!m) return true;
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const code = plain(line);
  // A one-letter name only counts as a whole word, or "n" would be found almost anywhere.
  const named = m[1]!.split(".").some((part) => (plain(part).length > 1 ? code.includes(plain(part)) : new RegExp(`(^|[^\\w$])${part.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(line)));
  const value = m[2]!.split(/\s*(?:→|->|,)\s*/)[0]!.replace(/^["'`]|["'`]$/g, "").trim();
  return named || (value.length > 2 && line.includes(value));
}

/**
 * A tour step made sound: marked lines must be on its card (a point with none just talks), a reveal needs a
 * claim, a point without one is labeled a guess, a value must sit on a line that names it, a fail step needs
 * hops that run along real edges, and a fail or why step needs a card.
 */
function cleanStep(s: BoardSpec["steps"][number], card: BoardCard | undefined, edgeKeys: Set<string>, note: (m: string) => void): BoardStep {
  const onCard = (n: number) => !!card && n >= card.start && n < card.start + card.lines.length;
  const lineText = (n: number) => card?.lines[n - card.start] ?? "";
  const beats = s.beats.flatMap((b): Beat[] => {
    const text = b.text.trim();
    const lines = b.lines.filter(onCard);
    const base = { text, tone: b.tone, lines: [] as number[], values: [] as Beat["values"], claim: null, analogy: false };
    const values = b.values
      .filter((v) => onCard(v.line) && v.text.trim())
      .filter((v) => valueFits(v.text, lineText(v.line)) || (note(`a value "${v.text.trim()}" names nothing on line ${v.line}, so it's dropped`), false))
      .map((v) => ({ line: v.line, text: v.text.trim().slice(0, 48) }))
      .slice(0, 4);
    if (b.kind === "reveal") {
      if (b.claim) return [{ ...base, kind: "reveal", text: text || b.claim.text, lines, values, claim: pending(b.claim, "behavior") }];
      note("a reveal without a claim is said instead");
    }
    if (!text) return [];
    if (b.kind === "point") {
      if (lines.length) {
        // What's said about marked lines is a claim. Without one from the writer it's shown as a guess resting on those lines.
        const claim = b.claim
          ? pending(b.claim, "behavior")
          : pending({ text, label: "inferred", evidence: [{ file: card!.file, start: Math.min(...lines), end: Math.max(...lines), mentions: [] }], commit: "", searched: "" }, "behavior");
        if (!b.claim) note("a point without a claim is labeled inferred");
        return [{ ...base, kind: "point", lines, values, claim }];
      }
      note("a point at lines that aren't on its card is said instead");
    }
    if (b.kind === "ask") return [{ ...base, kind: "ask", tone: "curious" }];
    return [{ ...base, kind: "say", analogy: b.analogy }];
  });
  const state: Held[] = s.part === "intro" || s.part === "flow"
    ? s.state.filter((h) => h.key.trim() && h.value.trim()).slice(0, 5).map((h) => ({ key: h.key.trim().slice(0, 30), value: h.value.trim().slice(0, 30), change: "new" }))
    : [];
  const hops = s.hops.filter((h) => edgeKeys.has(h.edge));
  let part = s.part;
  if ((part === "fail" && !hops.length) || ((part === "fail" || part === "why") && !card)) {
    note(`a ${part} step without ${card ? "a path along the board's links" : "a card"} is told as a plain step`);
    part = card ? "flow" : "close";
  }
  return { part, card: card?.id ?? "", route: part === "flow" ? s.route.filter((r) => edgeKeys.has(r)) : [], hops: part === "fail" ? hops : [], beats, state: part === "intro" || part === "flow" ? state : [] };
}

type OldBeat = { kind: string; text: string; tone?: BeatTone; lines?: number[]; claim?: AnalysisClaim | null };
type OldHop = Hop;
/** A single-tour board from before labeled points and the example's state. */
type V3Board = Omit<Board, "version" | "steps" | "example"> & {
  version: 3;
  steps: (Omit<BoardStep, "state" | "beats"> & { state?: Held[]; beats: (Omit<Beat, "analogy"> & { analogy?: boolean })[] })[];
  example?: AnalysisClaim | null;
};
type OldBoard = Omit<Board, "version" | "steps" | "example"> & {
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
export function upgradeBoard(raw: Board | V3Board | OldBoard): Board {
  if (raw.version === 4) return raw;
  // A v3 board keeps everything; its points stay unlabeled (nothing to check them against) and it has no state to show.
  const v3: V3Board = raw.version === 3 ? raw : fromOld(raw);
  return {
    ...v3,
    version: 4,
    example: v3.example ?? null,
    steps: v3.steps.map((s) => ({ ...s, state: s.state ?? [], beats: s.beats.map((bt) => ({ ...bt, analogy: bt.analogy ?? false })) })),
  };
}

function fromOld(b: OldBoard): V3Board {
  const n = b.steps.length;
  const steps: V3Board["steps"] = b.steps.map((s, i) => {
    const beats: V3Board["steps"][number]["beats"] =(s.beats ?? [{ kind: "say", text: s.text ?? "" }]).map((bt) => ({
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
  const fails: V3Board["steps"] =(b.tryIt?.scenarios ?? []).slice(1, 4).filter((sc) => sc.hops.length).map((sc) => ({
    part: "fail", card: cardOf(sc.hops[sc.hops.length - 1]!), route: [], hops: sc.hops,
    beats: [
      // Old scenario labels are button text ("Storage refuses", "PNG front, JPEG back"), so they're set up, not asked.
      { kind: "say", text: `Here's one that goes wrong: ${sc.label}.`, tone: "concerned", lines: [], values: [], claim: null },
      { kind: "reveal", text: sc.result.text, tone: "concerned", lines: [], values: [], claim: sc.result },
    ],
  }));
  const whys: V3Board["steps"] =(b.defend ?? []).filter((d) => d.card).slice(0, 3).map((d) => ({
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
    ...(b.example ? [b.example] : []),
  ];
}

/** Behind the board: the second reader tries to refute every confirmed and record claim. Labels settle. */
export async function checkBoard(llm: LlmProvider, facts: Facts, root: string, board: Board, { signal }: { signal?: AbortSignal } = {}): Promise<Board> {
  const reviewed = await refuteClaims(llm, facts, root, claimsOf(board), signal);
  return { ...putClaims(board, reviewed), status: "checked" };
}
