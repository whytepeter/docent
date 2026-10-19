import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Facts } from "@docent/extract";
import { redact } from "@docent/llm";
import type { Board, BoardCard, BoardStep, Flow } from "./board.ts";
import type { AnalysisClaim } from "./types.ts";

/*
 * Where a thrown error becomes the response. A service that throws a 401 doesn't answer the request itself: the error
 * travels on (an async wrapper hands it to next) until an error handler registered on the app sends the reply. Found
 * mechanically from the code, so a board's "what goes wrong" step can follow the error to the line that sends it.
 */

export interface Site {
  file: string;
  start: number;
  end: number;
  name: string;
}

export interface ErrorPath {
  /** Wrappers that pass a failed async handler's error on (catchAsync). */
  bridges: Site[];
  /** Lines that register the error handlers on the app, in the order they run. */
  registered: Site[];
  /** Error handlers, in the order they run. */
  handlers: Site[];
  /** The handler that sends the reply, and the line that sends it. */
  sender: { site: Site; line: number; text: string };
}

/** A line that throws or passes an error on, rather than answering on the spot. */
export const THROWS = /\bthrow\b|\bnext\(\s*(?:new\s|err)|\braise\b/;
/** Express-style error middleware: (err, req, res, next). */
const HANDLER_SIG = /\(\s*(?:err|error|e|ex|exception)\b[^,()]*,\s*\w+[^,()]*,\s*\w+[^,()]*,\s*\w+[^,()]*\)/;
/** Other frameworks' error handlers, on the decorator or call above the function: Nest @Catch, Flask errorhandler, FastAPI exception_handler. */
const HANDLER_MARK = /@Catch\(|\.errorhandler\(|\.exception_handler\(|setErrorHandler\(/;
const SENDS = /\b(?:res|response|reply)\b[\w.]*(?:\.status\([^)]*\))?\.(?:send|json|end|render|sendStatus)\(|\bjsonify\(|\bJSONResponse\(/;

/** The repo's error path, or null when no handler that sends a reply is found. */
export function findErrorPath(facts: Facts, root: string): ErrorPath | null {
  const code = new Set(facts.files.filter((f) => f.kind === "source").map((f) => f.path));
  const text = new Map<string, string[]>();
  const read = (p: string) => {
    if (!text.has(p)) {
      try {
        text.set(p, readFileSync(join(root, p), "utf8").split("\n"));
      } catch {
        text.set(p, []);
      }
    }
    return text.get(p)!;
  };
  const site = (s: Facts["symbols"][number]): Site => ({ file: s.file, start: s.range.start, end: s.range.end, name: s.name });
  const fns = facts.symbols.filter((s) => code.has(s.file) && (s.kind === "function" || s.kind === "const" || s.kind === "method" || s.kind === "class"));

  const handlers = fns.filter((s) => {
    const lines = read(s.file);
    const head = lines.slice(s.range.start - 1, s.range.start + 1).join(" ");
    const above = lines.slice(Math.max(0, s.range.start - 3), s.range.start).join(" ");
    return (HANDLER_SIG.test(head) || HANDLER_MARK.test(above)) && s.range.end - s.range.start < 80;
  }).map(site);
  if (!handlers.length) return null;

  // Where they're registered (app.use(errorHandler)), which also gives the order they run in.
  const names = new Set(handlers.map((h) => h.name));
  const registered: Site[] = [];
  // Only the handler's own name in a file that imports its module: morgan.errorHandler is someone else's.
  const homes = new Map(handlers.map((h) => [h.name, h.file.replace(/\.[^./]+$/, "").replace(/\/index$/, "")]));
  const imports = (lines: string[], target: string) =>
    lines.some((l) => [...l.matchAll(/(?:require\(|from\s+|import\s+)["'`](\.{1,2}\/[^"'`]+)["'`]/g)].some((m) => target.endsWith(m[1]!.replace(/^(\.{1,2}\/)+/, "").replace(/\.[^./]+$/, "").replace(/\/index$/, ""))));
  for (const p of code) {
    const lines = read(p);
    lines.forEach((l, i) => {
      const m = /\.use\(\s*([\w$]+)\s*\)/.exec(l);
      if (m && names.has(m[1]!) && (homes.get(m[1]!) === p.replace(/\.[^./]+$/, "") || imports(lines, homes.get(m[1]!)!))) registered.push({ file: p, start: i + 1, end: i + 1, name: m[1]! });
    });
  }
  const order = (h: Site) => {
    const i = registered.findIndex((r) => r.name === h.name);
    return i < 0 ? registered.length : i;
  };
  const ordered = [...handlers].sort((a, b) => order(a) - order(b));
  // The reply is sent by the last handler that runs and has a line that sends.
  let sender: ErrorPath["sender"] | null = null;
  for (const h of [...ordered].reverse()) {
    const lines = read(h.file);
    for (let n = h.end; n >= h.start; n--) {
      if (SENDS.test(lines[n - 1] ?? "")) {
        sender = { site: h, line: n, text: SENDS.exec(lines[n - 1]!)![0] };
        break;
      }
    }
    if (sender) break;
  }
  if (!sender) return null;
  // Only the handlers that run up to the one that sends, and only registered ones when any are.
  const upTo = ordered.slice(0, ordered.indexOf(sender.site) + 1).filter((h) => !registered.length || order(h) < registered.length);

  const bridges = fns.filter((s) => {
    if (s.range.end - s.range.start > 15) return false;
    // A wrapper around the route's own function (fn): it calls what it was given and sends a rejection to next.
    const body = read(s.file).slice(s.range.start - 1, s.range.end).join("\n");
    const param = /\(\s*([A-Za-z_$][\w$]*)/.exec(body)?.[1];
    return !!param && body.includes(`${param}(`) && /\.catch\(/.test(body) && /\bnext\b/.test(body);
  }).map(site);

  return { bridges, registered, handlers: upTo, sender };
}

/** The bridges a flow's files actually call. */
function bridgesOf(facts: Facts, path: ErrorPath, files: string[]): Site[] {
  const set = new Set(files);
  return path.bridges.filter((b) => facts.edges.some((e) => e.to === `${b.file}#${b.name}` && set.has(e.from.split("#")[0]!)));
}

/** Whether any of the flow's files throws or passes an error on. */
function flowThrows(root: string, files: string[]): boolean {
  return files.some((f) => {
    try {
      return readFileSync(join(root, f), "utf8").split("\n").some((l) => THROWS.test(l));
    } catch {
      return false;
    }
  });
}

/**
 * For the writer's prompt: the code a thrown error runs through until the reply is sent, numbered, when the flow
 * throws and the handler isn't among its own files. Empty otherwise.
 */
export function errorPathSource(facts: Facts, root: string, flow: Flow, path = findErrorPath(facts, root)): string {
  if (!path || flow.files.includes(path.sender.site.file) || !flowThrows(root, flow.files)) return "";
  const sites = [...bridgesOf(facts, path, flow.files), ...path.registered.map((r) => ({ ...r, start: Math.max(1, r.start - 1), end: r.end + 1 })), ...path.handlers];
  const out = ["Where a thrown error becomes the response (line numbers are real; cite them). An error the flow throws travels through this code:"];
  for (const s of sites) {
    const lines = readFileSync(join(root, s.file), "utf8").split("\n");
    out.push("", `=== ${s.file} lines ${s.start}–${s.end} (${s.name})`, lines.slice(s.start - 1, s.end).map((l, i) => `${String(s.start + i).padStart(5)}  ${redact(l)}`).join("\n"));
  }
  out.push("", `The reply is sent at ${path.sender.site.file}:${path.sender.line}.`);
  return out.join("\n");
}

const MAX = 26;
const checkLater = (c: Omit<AnalysisClaim, "evidence"> & { evidence: { file: string; start: number; end: number; mentions: string[] }[] }): AnalysisClaim =>
  ({ ...c, evidence: c.evidence.map((e) => ({ ...e, check: { ok: false, reason: "not checked yet" } })) });

/**
 * A fail step that ends at a throw leaves the newcomer at the throw. When the writer didn't follow the error itself,
 * this does, from the code: the error handler goes on the board as a card, each throwing fail step's path continues
 * to it, and one step after the first of them points at the line that sends the reply, with evidence for each hand-off
 * (the async wrapper, where the handlers are registered, the send). Claims are checked like any other.
 */
export function followErrors(board: Board, facts: Facts, root: string, flow: Flow, path = findErrorPath(facts, root)): Board {
  if (!path) return board;
  const read = (p: string) => readFileSync(join(root, p), "utf8").split("\n");
  const throwsAt = (s: BoardStep): boolean => {
    if (s.part !== "fail" || !s.card) return false;
    const card = board.cards.find((c) => c.id === s.card);
    const marked = s.beats.flatMap((b) => b.lines).some((n) => card && THROWS.test(card.lines[n - card.start] ?? ""));
    const cited = s.beats.flatMap((b) => b.claim?.evidence ?? []).some((e) => {
      try {
        return read(e.file).slice(e.start - 1, e.end).some((l) => THROWS.test(l));
      } catch {
        return false;
      }
    });
    return marked || cited;
  };
  const throwing = board.steps.filter(throwsAt);
  if (!throwing.length) return board;

  const { sender } = path;
  const covers = (c: BoardCard) => c.file === sender.site.file && sender.line >= c.start && sender.line < c.start + c.lines.length;
  let handler = board.cards.find(covers);
  const cards = [...board.cards];
  const notes = [...board.notes];
  if (!handler) {
    const all = read(sender.site.file);
    const start = sender.site.end - sender.site.start < MAX ? sender.site.start : Math.max(sender.site.start, sender.line - MAX + 4);
    const end = Math.min(sender.site.end, start + MAX - 1, all.length);
    const ids = new Set(cards.map((c) => c.id));
    let id = "error-handler";
    for (let k = 2; ids.has(id); k++) id = `error-handler-${k}`;
    const reg = path.registered;
    handler = {
      id, n: cards.length + 1, title: "Error handler", file: sender.site.file, start, lines: all.slice(start - 1, end).map((l) => redact(l)),
      hot: [sender.line], role: "Turns an error thrown anywhere in a request into the reply the client gets.",
      why: reg.length
        ? checkLater({ kind: "why", text: "It's registered on the app after the routes, so an error any route passes on ends here.", label: "confirmed", evidence: reg.map((r) => ({ file: r.file, start: r.start, end: r.end, mentions: [r.name] })), commit: "", searched: "" })
        : checkLater({ kind: "why", text: "One handler answers every error, so no route builds its own error reply.", label: "inferred", evidence: [{ file: sender.site.file, start: sender.site.start, end: sender.site.start, mentions: [sender.site.name] }], commit: "", searched: "" }),
      say: checkLater({ kind: "behavior", text: "This is where the error reply is sent back to the client.", label: "confirmed", evidence: [{ file: sender.site.file, start: sender.line, end: sender.line, mentions: [sender.text] }], commit: "", searched: "" }),
    };
    cards.push(handler);
    notes.push(`added the error handler (${sender.site.file}:${sender.line}) so the failure path reaches the reply`);
  }

  const edges = [...board.edges];
  const steps: BoardStep[] = [];
  let explained = board.steps.some((s) => s.part === "fail" && s.card === handler!.id);
  const bridges = bridgesOf(facts, path, [...flow.files, ...board.cards.map((c) => c.file)]);
  for (const s of board.steps) {
    if (!throwing.includes(s) || s.card === handler.id) {
      steps.push(s);
      continue;
    }
    const edge = `${s.card}>${handler.id}`;
    if (!edges.some((e) => `${e.from}>${e.to}` === edge)) edges.push({ from: s.card, to: handler.id, label: "thrown error", shape: null });
    const last = s.hops[s.hops.length - 1];
    const status = /\b[1-5]\d\d\b/.exec(last?.stat ?? "")?.[0];
    const hop = { edge, back: false, stat: status ? `${status} sent` : "error sent", tone: "bad" as const };
    const reaches = last?.edge.split(">")[last.back ? 0 : 1] === handler.id;
    const hops = reaches ? s.hops : [...s.hops, hop];
    steps.push({ ...s, hops });
    if (explained) continue;
    explained = true;
    const sendLine = handler.lines[sender.line - handler.start] ?? "";
    const statusName = /status\(\s*([\w$.]+)\s*\)/.exec(sendLine)?.[1];
    steps.push({
      part: "fail", card: handler.id, route: [], touches: [], state: [], hops,
      beats: [
        { kind: "say", text: bridges.length ? "The throw doesn't answer the request by itself. A small wrapper catches it and passes it on." : "The throw doesn't answer the request by itself. The error travels on.", tone: "concerned", lines: [], values: [], focus: [], claim: null, analogy: false },
        {
          kind: "point", text: `It lands in the error handler${path.registered.length ? " registered at the end of the app" : ""}, and this line sends the reply the client sees.`, tone: "concerned",
          lines: [sender.line],
          values: status && statusName ? [{ line: sender.line, text: `${statusName} = ${status}`, other: "" }] : [],
          focus: [{ line: sender.line, text: sender.text, cue: "sends" }],
          claim: checkLater({
            kind: "behavior", label: "confirmed", commit: "", searched: "",
            text: `The thrown error ${bridges.length ? "is passed to next by the async wrapper, " : ""}reaches the error handler${path.registered.length ? " registered on the app" : ""}, which sends the reply.`,
            evidence: [
              ...bridges.map((b) => ({ file: b.file, start: b.start, end: b.end, mentions: ["next"] })),
              ...path.registered.map((r) => ({ file: r.file, start: r.start, end: r.end, mentions: [r.name] })),
              { file: sender.site.file, start: sender.line, end: sender.line, mentions: [sender.text] },
            ],
          }),
          analogy: false,
        },
      ],
    });
  }
  return { ...board, cards, edges, steps, notes };
}
