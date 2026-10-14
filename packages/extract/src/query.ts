import type { EdgeFact, Facts, SymbolFact, TestFact } from "./types.ts";

export function findSymbols(facts: Facts, query: string): SymbolFact[] {
  const q = query.replace(/\(\)$/, "");
  const exact = facts.symbols.filter((s) => s.id === q || s.id.endsWith(`#${q}`));
  return exact.length ? exact : facts.symbols.filter((s) => s.name === q);
}

export interface Connections {
  symbol: SymbolFact;
  callers: EdgeFact[];
  callees: EdgeFact[];
  /** Tests that reach the symbol directly, or through one helper. */
  tests: { test: TestFact; edge: EdgeFact; hops: number }[];
  /** Commits that touched the symbol's file, newest first. */
  history: Facts["commits"];
  /** Docs and agent files that name the symbol or its file. */
  mentions: { doc: string; line: number; text: string }[];
  cochange: { file: string; count: number }[];
}

export function connections(facts: Facts, symbol: SymbolFact): Connections {
  const nested = (id: string) => id === symbol.id || id.startsWith(`${symbol.id}.`);
  const callers = facts.edges.filter((e) => e.to === symbol.id && !nested(e.from));
  const callees = facts.edges.filter((e) => nested(e.from) && !nested(e.to));

  const testsById = new Map(facts.tests.map((t) => [t.id, t]));
  const tests: Connections["tests"] = [];
  for (const edge of callers) {
    const direct = testsById.get(edge.from);
    if (direct) tests.push({ test: direct, edge, hops: 0 });
  }
  for (const edge of callers.filter((e) => !testsById.has(e.from))) {
    for (const outer of facts.edges.filter((e) => e.to === edge.from && testsById.has(e.from))) {
      tests.push({ test: testsById.get(outer.from)!, edge: outer, hops: 1 });
    }
  }

  const mentions = facts.docs.flatMap((doc) =>
    doc.mentions
      .filter((m) => m.target === symbol.id || m.target === symbol.file)
      .map((m) => ({ doc: doc.path, line: m.line, text: m.text })),
  );

  return {
    symbol,
    callers,
    callees,
    tests: dedupeBy(tests, (t) => t.test.id),
    history: facts.commits.filter((c) => c.files.includes(symbol.file)),
    mentions,
    cochange: facts.cochange[symbol.file] ?? [],
  };
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(key(item)) ? false : (seen.add(key(item)), true)));
}
