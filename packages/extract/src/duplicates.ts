import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DuplicateFact, FileFact, SymbolFact } from "./types.ts";

const MIN_EXACT = 8; // lines; shorter bodies repeat by accident
const MIN_SHAPE = 12;
const KINDS = new Set<SymbolFact["kind"]>(["function", "component", "method"]);
const KEYWORDS = new Set(
  ("async await break case catch class const continue default delete do else export extends false finally for function if import in " +
    "instanceof let new null of return static super switch this throw true try typeof undefined var void while yield as interface type " +
    "readonly keyof satisfies").split(" "),
);

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const hasLogic = (s: string) => /\b(if|for|while|switch|try|catch|await)\b/.test(s) || (s.match(/;/g)?.length ?? 0) >= 4;
const hash = (s: string) => createHash("sha1").update(s).digest("hex");

/**
 * Copy-pasted logic across files. "exact": the same body once comments, spacing and the function's
 * own name are ignored (confirmed). "shape": the same body with every name and literal replaced,
 * i.e. the same code with renamed variables (inferred: it can be a coincidence of shape).
 */
export function findDuplicates(root: string, files: FileFact[], symbols: SymbolFact[]): DuplicateFact[] {
  const source = new Set(files.filter((f) => f.kind === "source").map((f) => f.path));
  const text = new Map<string, string[]>();
  const lines = (file: string) => {
    if (!text.has(file)) text.set(file, readFileSync(join(root, file), "utf8").split("\n"));
    return text.get(file)!;
  };
  const candidates = symbols
    .filter((s) => KINDS.has(s.kind) && source.has(s.file) && s.range.end - s.range.start + 1 >= MIN_EXACT)
    .sort((a, b) => b.range.end - b.range.start - (a.range.end - a.range.start));

  const exact = new Map<string, SymbolFact[]>();
  const shape = new Map<string, SymbolFact[]>();
  for (const s of candidates) {
    const body = stripComments(lines(s.file).slice(s.range.start - 1, s.range.end).join("\n")).replaceAll(s.name, "$self");
    const e = squash(body);
    exact.set(hash(e), [...(exact.get(hash(e)) ?? []), s]);
    // Same shape only counts for real logic. Thin wrappers that pass different settings to one
    // shared component or function have the same shape by design.
    if (s.range.end - s.range.start + 1 >= MIN_SHAPE && hasLogic(e)) {
      const shaped = e
        .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "0")
        .replace(/\b\d[\d_.]*\b/g, "0")
        .replace(/[A-Za-z_$][\w$]*/g, (w) => (KEYWORDS.has(w) ? w : "_"));
      shape.set(hash(shaped), [...(shape.get(hash(shaped)) ?? []), s]);
    }
  }

  const out: DuplicateFact[] = [];
  const taken: SymbolFact[] = [];
  // A member inside a larger duplicate (a method of a copied class) is part of that one, not its own.
  const inside = (s: SymbolFact) => taken.some((t) => t !== s && t.file === s.file && t.range.start <= s.range.start && t.range.end >= s.range.end);
  const add = (kind: DuplicateFact["kind"], group: SymbolFact[]) => {
    const members = group.filter((s) => !inside(s) && !taken.includes(s));
    if (members.length < 2 || new Set(members.map((m) => m.file)).size < 2) return;
    taken.push(...members);
    out.push({
      kind,
      confidence: kind === "exact" ? "confirmed" : "inferred",
      lines: Math.min(...members.map((m) => m.range.end - m.range.start + 1)),
      members: members.map((m) => ({ symbol: m.id, file: m.file, start: m.range.start, end: m.range.end })),
    });
  };
  for (const g of exact.values()) add("exact", g);
  for (const g of shape.values()) add("shape", g);
  return out.sort((a, b) => b.lines * b.members.length - a.lines * a.members.length);
}
