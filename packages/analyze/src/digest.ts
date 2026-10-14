import type { Facts } from "@docent/extract";

const CODE = new Set(["source", "generated"]);
const NAMED = new Set(["function", "component", "method", "class"]);

/**
 * A compact, plain-text view of the facts for discovery: every source file with what it exports,
 * what it imports, how it's tested and what it usually changes with. Claude reasons over this
 * instead of wandering the repo, and every name in it is real.
 */
export function discoveryDigest(facts: Facts): string {
  const files = facts.files.filter((f) => CODE.has(f.kind));
  const byFile = new Map<string, string[]>();
  for (const s of facts.symbols) {
    if (!NAMED.has(s.kind) || s.parent) continue;
    byFile.set(s.file, [...(byFile.get(s.file) ?? []), `${s.name}${s.kind === "component" ? " (component)" : ""}${s.exported ? "" : " (private)"}`]);
  }
  const imports = new Map<string, Set<string>>();
  for (const i of facts.imports) {
    if (!i.to || i.kind === "type") continue;
    imports.set(i.from, (imports.get(i.from) ?? new Set()).add(i.to));
  }
  const testsFor = new Map<string, number>();
  for (const e of facts.edges) {
    if (!e.from.includes("#test:")) continue;
    const target = e.to.split("#")[0]!;
    testsFor.set(target, (testsFor.get(target) ?? 0) + 1);
  }

  const out: string[] = [];
  out.push(`Repository: ${facts.repo.name} (commit ${facts.repo.head ?? "?"})`);
  out.push(`Stack: ${facts.stack.join(", ") || "unknown"}`);
  out.push(`Entry points: ${facts.entries.filter((e) => e.kind !== "script").map((e) => `${e.file} (${e.kind})`).join(", ") || "none found"}`);
  out.push(`Scripts: ${facts.entries.filter((e) => e.kind === "script").map((e) => e.detail).join("; ")}`);
  out.push("");
  out.push("Files (path — lines — exports — imports — test links):");
  for (const f of files) {
    const ex = byFile.get(f.path)?.slice(0, 12).join(", ") ?? "";
    const im = [...(imports.get(f.path) ?? [])].slice(0, 12).join(", ");
    const t = testsFor.get(f.path);
    out.push(`- ${f.path} — ${f.lines}L${ex ? ` — exports: ${ex}` : ""}${im ? ` — imports: ${im}` : ""}${t ? ` — ${t} test links` : ""}`);
  }
  const pairs = Object.entries(facts.cochange)
    .flatMap(([a, xs]) => xs.filter((x) => a < x.file && x.count >= 3).map((x) => `${a} + ${x.file} (×${x.count})`))
    .slice(0, 60);
  if (pairs.length) {
    out.push("");
    out.push("Files that usually change together (from git history):");
    out.push(...pairs.map((p) => `- ${p}`));
  }
  out.push("");
  out.push(`Docs and agent notes exist (hints only, may be stale): ${facts.docs.map((d) => d.path).slice(0, 30).join(", ")}`);
  return out.join("\n");
}

/** The slice of facts one verification worker needs: its files' symbols and the links between them. */
export function featureDigest(facts: Facts, files: string[]): string {
  const set = new Set(files);
  const out: string[] = [];
  out.push("Symbols in this feature (id — kind — lines):");
  for (const s of facts.symbols) {
    if (!set.has(s.file) || !NAMED.has(s.kind)) continue;
    out.push(`- ${s.id} — ${s.kind} — ${s.range.start}-${s.range.end}`);
  }
  out.push("");
  out.push("Calls and renders that cross this feature's boundary or stay inside it (from → to @ file:line, confirmed by the compiler unless marked):");
  let n = 0;
  for (const e of facts.edges) {
    const fromFile = e.from.split("#")[0]!;
    const toFile = e.to.split("#")[0]!;
    if (!set.has(fromFile) && !set.has(toFile)) continue;
    if (n++ > 400) break;
    out.push(`- ${e.from} → ${e.to} (${e.kind}) @ ${e.file}:${e.line}${e.confidence !== "confirmed" ? ` [${e.confidence}${e.via ? `: ${e.via}` : ""}]` : ""}`);
  }
  out.push("");
  out.push("Tests that reach it:");
  for (const t of facts.tests) {
    if (set.has(t.file)) out.push(`- ${t.id} @ ${t.file}:${t.range.start}`);
  }
  const commits = facts.commits.filter((c) => c.files.some((f) => set.has(f))).slice(0, 25);
  out.push("");
  out.push("Commits that touched these files (sha date subject; bodies often hold the reason):");
  for (const c of commits) out.push(`- ${c.sha} ${c.date} ${c.subject}${c.body ? `\n  ${c.body.split("\n").slice(0, 6).join("\n  ")}` : ""}`);
  return out.join("\n");
}
