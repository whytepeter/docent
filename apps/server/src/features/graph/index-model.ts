import type {
  Area, AreaLink, AreaView, CommitRef, FileView, Health, Link, Mention, Overview, SearchHit, SymbolRef, SymbolView, TestRef, TreeNode,
} from "@docent/contracts";
import { connections, type CommitFact, type EdgeFact, type Facts, type FileFact, type SymbolFact } from "@docent/extract";
import { areaOf } from "./areas.ts";

const CODE_KINDS = new Set(["source", "test", "generated"]);
const NAVIGABLE = new Set(["function", "component", "method", "class"]);

/** Lookup tables over one fact set. Rebuilt whenever the facts are re-read. */
export class GraphIndex {
  private readonly symbols = new Map<string, SymbolFact>();
  private readonly byFile = new Map<string, SymbolFact[]>();
  private readonly files = new Map<string, FileFact>();
  private readonly areaByFile = new Map<string, string>();
  private readonly areas = new Map<string, Area>();
  private readonly unreferenced: Set<string>;

  constructor(readonly facts: Facts) {
    for (const s of facts.symbols) {
      this.symbols.set(s.id, s);
      this.byFile.set(s.file, [...(this.byFile.get(s.file) ?? []), s]);
    }
    for (const f of facts.files) this.files.set(f.path, f);
    this.unreferenced = new Set(facts.unreferenced.map((u) => u.file));

    for (const f of facts.files.filter((x) => CODE_KINDS.has(x.kind))) {
      const a = areaOf(f.path);
      this.areaByFile.set(f.path, a.id);
      const area = this.areas.get(a.id) ?? { ...a, files: 0, functions: 0, tests: 0 };
      area.files += 1;
      area.functions += (this.byFile.get(f.path) ?? []).filter((s) => NAVIGABLE.has(s.kind)).length;
      this.areas.set(a.id, area);
    }
    for (const t of facts.tests) {
      const area = this.areas.get(this.areaByFile.get(t.file) ?? "");
      if (area) area.tests += 1;
    }
  }

  // ---------- references

  ref(id: string): SymbolRef {
    const s = this.symbols.get(id);
    if (s) return { id, name: s.name, kind: s.kind, file: s.file, line: s.range.start, label: id.split("#")[1] ?? s.name };
    const [file = "", rest = id] = id.split("#");
    if (rest.startsWith("test:")) return { id, name: rest.slice(5), kind: "unknown", file, line: 0, label: `test: ${rest.slice(5)}` };
    if (rest === "<module>") return { id, name: "top level", kind: "unknown", file, line: 0, label: `top level of ${file.split("/").pop()}` };
    return { id, name: rest.split(".").pop() ?? rest, kind: "unknown", file, line: 0, label: rest };
  }

  area(id: string | undefined): Area | null {
    return id ? this.areas.get(id) ?? null : null;
  }

  private commit(c: CommitFact): CommitRef {
    return { sha: c.sha, date: c.date, subject: c.subject, body: c.body };
  }

  private mentionsOf(targets: string[]): Mention[] {
    const set = new Set(targets);
    return this.facts.docs.flatMap((doc) =>
      doc.mentions.filter((m) => m.target && set.has(m.target)).map((m) => ({ doc: doc.path, line: m.line, text: m.text, kind: doc.kind })),
    );
  }

  private group(edges: EdgeFact[], side: "from" | "to"): Link[] {
    const groups = new Map<string, EdgeFact[]>();
    for (const e of edges) {
      const key = `${e.kind}|${e[side]}|${e.file}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    return [...groups.values()].map((es) => {
      const first = es[0]!;
      const inferred = es.find((e) => e.confidence !== "confirmed");
      return {
        symbol: this.ref(first[side]),
        kind: first.kind,
        file: first.file,
        lines: [...new Set(es.map((e) => e.line))].sort((a, b) => a - b),
        confidence: inferred?.confidence ?? "confirmed",
        ...(inferred?.via ? { via: inferred.via } : {}),
      };
    });
  }

  // ---------- views

  overview(): Overview {
    const counts = new Map<string, number>();
    for (const imp of this.facts.imports) {
      if (!imp.to || imp.kind === "type") continue;
      const from = this.areaByFile.get(imp.from);
      const to = this.areaByFile.get(imp.to);
      if (!from || !to || from === to) continue;
      counts.set(`${from}|${to}`, (counts.get(`${from}|${to}`) ?? 0) + 1);
    }
    const links: AreaLink[] = [...counts].map(([key, count]) => {
      const [from = "", to = ""] = key.split("|");
      return { from, to, count };
    });
    const symbols = this.facts.symbols;
    return {
      repo: { name: this.facts.repo.name, head: this.facts.repo.head, dirty: this.facts.repo.dirty, extractedAt: this.facts.repo.extractedAt },
      stack: this.facts.stack,
      areas: [...this.areas.values()].sort((a, b) => a.id.localeCompare(b.id)),
      links,
      entries: this.facts.entries.filter((e) => e.kind !== "script"),
      counts: {
        files: this.facts.files.filter((f) => f.kind === "source").length,
        functions: symbols.filter((s) => s.kind === "function" || s.kind === "method").length,
        components: symbols.filter((s) => s.kind === "component").length,
        tests: this.facts.tests.length,
        commits: this.facts.commits.length,
      },
    };
  }

  areaView(id: string): AreaView | null {
    const area = this.areas.get(id);
    if (!area) return null;
    const files = [...this.areaByFile].filter(([, a]) => a === id).map(([path]) => path).sort();
    const inArea = new Set(files);
    const importers = new Map<string, number>();
    const links: AreaView["links"] = [];
    const inbound = new Map<string, number>();
    const outbound = new Map<string, number>();
    for (const imp of this.facts.imports) {
      if (!imp.to || imp.kind === "type") continue;
      const fromIn = inArea.has(imp.from);
      const toIn = inArea.has(imp.to);
      if (toIn) importers.set(imp.to, (importers.get(imp.to) ?? 0) + 1);
      if (fromIn && toIn) links.push({ from: imp.from, to: imp.to });
      else if (fromIn) {
        const other = this.areaByFile.get(imp.to);
        if (other) outbound.set(other, (outbound.get(other) ?? 0) + 1);
      } else if (toIn) {
        const other = this.areaByFile.get(imp.from);
        if (other) inbound.set(other, (inbound.get(other) ?? 0) + 1);
      }
    }
    const tests = new Map<string, number>();
    for (const t of this.facts.tests) tests.set(t.file, (tests.get(t.file) ?? 0) + 1);
    return {
      area,
      files: files.map((path) => ({
        path,
        functions: (this.byFile.get(path) ?? []).filter((s) => NAVIGABLE.has(s.kind) && !s.parent).length,
        tests: tests.get(path) ?? 0,
        importers: importers.get(path) ?? 0,
        unreferenced: this.unreferenced.has(path),
      })),
      links,
      inbound: [...inbound].map(([from, count]) => ({ from, to: id, count })).sort((a, b) => b.count - a.count),
      outbound: [...outbound].map(([to, count]) => ({ from: id, to, count })).sort((a, b) => b.count - a.count),
    };
  }

  fileView(path: string): FileView | null {
    const file = this.files.get(path);
    if (!file) return null;
    const own = (this.byFile.get(path) ?? []).filter((s) => NAVIGABLE.has(s.kind) || (s.kind === "const" && s.exported));
    const testIds = new Set<string>();
    for (const e of this.facts.edges) if (e.to.startsWith(`${path}#`) && e.from.includes("#test:")) testIds.add(e.from);
    const tests: TestRef[] = this.facts.tests
      .filter((t) => t.file === path || testIds.has(t.id))
      .map((t) => ({ id: t.id, name: t.name, file: t.file, line: t.range.start, hops: 0 }));
    return {
      file,
      area: this.area(this.areaByFile.get(path)),
      symbols: own.filter((s) => !s.parent).map((s) => this.ref(s.id)),
      importers: this.facts.imports.filter((i) => i.to === path).map((i) => ({ file: i.from, line: i.line, names: i.names })),
      imports: this.facts.imports.filter((i) => i.from === path).map((i) => ({ file: i.to, external: i.external, names: i.names, line: i.line, kind: i.kind })),
      tests,
      mentions: this.mentionsOf([path]),
      history: this.facts.commits.filter((c) => c.files.includes(path)).map((c) => this.commit(c)),
      cochange: this.facts.cochange[path] ?? [],
      unreferenced: this.unreferenced.has(path),
    };
  }

  symbolView(id: string): SymbolView | null {
    const s = this.symbols.get(id);
    if (!s) return null;
    const c = connections(this.facts, s);
    const notTest = (e: EdgeFact) => !e.from.includes("#test:");
    return {
      symbol: { ...this.ref(id), end: s.range.end, exported: s.exported },
      area: this.area(this.areaByFile.get(s.file)),
      parent: s.parent ? this.ref(s.parent) : null,
      children: this.facts.symbols.filter((x) => x.parent === id).map((x) => this.ref(x.id)),
      callers: this.group(c.callers.filter(notTest), "from"),
      callees: this.group(c.callees, "to"),
      tests: c.tests.map((t) => ({ id: t.test.id, name: t.test.name, file: t.test.file, line: t.test.range.start, hops: t.hops })),
      mentions: this.mentionsOf([id, s.file]),
      history: c.history.map((h) => this.commit(h)),
      cochange: c.cochange,
    };
  }

  tree(): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const area of [...this.areas.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const files = [...this.areaByFile].filter(([path, a]) => a === area.id && this.files.get(path)?.kind !== "test").map(([p]) => p).sort();
      nodes.push({
        id: area.id, label: area.label, kind: "area", group: area.group, route: { view: "area", id: area.id },
        children: files.map((path) => ({
          id: path, label: path.split("/").pop()!, kind: "file", route: { view: "file", path },
          children: (this.byFile.get(path) ?? []).filter((s) => NAVIGABLE.has(s.kind) && !s.parent)
            .map((s) => ({ id: s.id, label: s.name, kind: "symbol", symbolKind: s.kind, route: { view: "fn", id: s.id } })),
        })),
      });
    }
    return nodes;
  }

  search(query: string): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const score = (text: string) => {
      const t = text.toLowerCase();
      if (t === q) return 0;
      if (t.startsWith(q)) return 1;
      if (t.includes(q)) return 2;
      // initials: "sd" → submitDocument
      const initials = text.replace(/[^A-Z]/g, "").toLowerCase();
      return (text[0]!.toLowerCase() + initials).startsWith(q) ? 3 : 9;
    };
    const hits: (SearchHit & { score: number })[] = [];
    for (const s of this.facts.symbols) {
      if (!NAVIGABLE.has(s.kind)) continue;
      const sc = score(s.name);
      if (sc < 9) hits.push({ kind: "symbol", label: s.name, detail: s.id.split("#")[0]!, symbolKind: s.kind, route: { view: "fn", id: s.id }, score: sc + (s.parent ? 0.5 : 0) });
    }
    for (const f of this.facts.files) {
      if (!CODE_KINDS.has(f.kind)) continue;
      const sc = score(f.path.split("/").pop()!);
      if (sc < 9) hits.push({ kind: "file", label: f.path.split("/").pop()!, detail: f.path, route: { view: "file", path: f.path }, score: sc + 0.2 });
    }
    for (const a of this.areas.values()) {
      const sc = Math.min(score(a.label), score(a.id.split("/").pop()!));
      if (sc < 9) hits.push({ kind: "area", label: a.label, detail: a.path, route: { view: "area", id: a.id }, score: sc + 0.1 });
    }
    return hits.sort((a, b) => a.score - b.score || a.label.length - b.label.length).slice(0, 40).map(({ score: _s, ...hit }) => hit);
  }

  health(): Health {
    return {
      missingPaths: this.facts.docs.flatMap((d) => d.mentions.filter((m) => m.missing).map((m) => ({ doc: d.path, line: m.line, text: m.text, kind: d.kind }))),
      unreferenced: this.facts.unreferenced.map((u) => ({ file: u.file, reason: u.reason })),
      inferred: this.facts.edges.filter((e) => e.confidence !== "confirmed").map((e) => ({ from: e.from, to: e.to, file: e.file, line: e.line, ...(e.via ? { via: e.via } : {}) })),
    };
  }
}
