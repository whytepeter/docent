import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTestPath } from "./repo.ts";
import type { Graph } from "./ts-graph.ts";
import { endLineOf, field, lineOf, named, type Node, type Tree } from "./trees.ts";
import type { Parser } from "web-tree-sitter";
import type { Confidence, EdgeFact, ImportFact, SymbolFact, TestFact } from "./types.ts";

/**
 * Python's call graph, read from the syntax tree. There is no type checker, so a call is confirmed only when
 * its target is fixed by the code itself: a name the file defines or imports, `self.method()` inside the
 * class, `module.func()` through an import, `Class.method`. A method reached through a variable whose class
 * comes from an assignment or an annotation is inferred, and so is a method matched by its name alone.
 */

/** Methods of the built-in types: a call like `x.get()` says nothing about which repo method runs. */
const BUILTIN_METHODS = new Set(
  ("get set pop append extend insert remove clear copy update keys values items add discard sort reverse index count " +
    "split join strip lstrip rstrip replace format lower upper startswith endswith encode decode find read write close " +
    "open run send start stop list dict filter map").split(" "),
);

interface PyFile {
  path: string;
  module: string;
  tree: Tree;
  test: boolean;
}

interface Binding {
  /** The file a module import leads to, or the file that defines an imported name. */
  file: string;
  /** The name imported from it; null when the binding is the module itself. */
  name: string | null;
}

type Target = { id: string; confidence: Confidence; via?: string } | null;

/** `app/services/notes.py` → `app.services.notes`; `app/__init__.py` → `app`. */
const moduleOf = (path: string) => path.replace(/\.py$/, "").replace(/\/__init__$/, "").replace(/\//g, ".");

export function buildPythonGraph(root: string, paths: string[], parser: Parser): Graph {
  const files: PyFile[] = [];
  const warnings: string[] = [];
  for (const path of paths) {
    const tree = parser.parse(readFileSync(join(root, path), "utf8"));
    if (!tree) {
      warnings.push(`${path}: could not be parsed`);
      continue;
    }
    files.push({ path, module: moduleOf(path), tree, test: isTestPath(path) });
  }

  // Modules by dotted name: as written from the repo root, and from inside a `src/` layout.
  const modules = new Map<string, string>();
  for (const f of files) {
    modules.set(f.module, f.path);
    const src = /^(?:.*\/)?src\/(.+)$/.exec(f.path);
    if (src) modules.set(moduleOf(src[1]!), f.path);
  }
  const bySuffix = (mod: string): string | null => {
    const hits = files.filter((f) => f.module.endsWith(`.${mod}`));
    return hits.length === 1 ? hits[0]!.path : null;
  };
  const resolveModule = (mod: string): { file: string; confidence: Confidence } | null => {
    const exact = modules.get(mod);
    if (exact) return { file: exact, confidence: "confirmed" };
    const suffix = bySuffix(mod);
    return suffix ? { file: suffix, confidence: "inferred" } : null;
  };

  const symbols: SymbolFact[] = [];
  const symbolIds = new Set<string>();
  const tests: TestFact[] = [];
  const imports: ImportFact[] = [];
  const bindings = new Map<string, Map<string, Binding>>(); // file → local name → binding
  const starImports = new Map<string, string[]>(); // file → files imported with `*`
  const classBases = new Map<string, string[]>(); // class id → base class names as written
  const methodsByName = new Map<string, string[]>();

  const addSymbol = (s: SymbolFact) => {
    if (symbolIds.has(s.id)) return;
    symbolIds.add(s.id);
    symbols.push(s);
    if (s.kind === "method") methodsByName.set(s.name, [...(methodsByName.get(s.name) ?? []), s.id]);
  };

  // ---- pass 1: definitions, tests and imports
  for (const f of files) {
    const local = new Map<string, Binding>();
    bindings.set(f.path, local);
    const pkg = f.path.endsWith("/__init__.py") ? f.module : f.module.split(".").slice(0, -1).join(".");

    const define = (node: Node, chain: string[], inClass: string | null, parent: string | null) => {
      const def = node.type === "decorated_definition" ? field(node, "definition") : node;
      if (!def) return;
      const name = field(def, "name")?.text;
      if (!name) return;
      const start = lineOf(node); // decorators belong to the definition: `@app.route` is where a reader looks
      const id = `${f.path}#${[...chain, name].join(".")}`;
      if (def.type === "class_definition") {
        addSymbol({ id, name, kind: "class", file: f.path, range: { start, end: endLineOf(def) }, exported: !name.startsWith("_"), parent });
        classBases.set(id, named(field(def, "superclasses") ?? def).filter((n) => n.type === "identifier" || n.type === "attribute").map((n) => n.text));
        const body = field(def, "body");
        if (body) for (const child of named(body)) define(child, [...chain, name], id, id);
        return;
      }
      if (def.type !== "function_definition") return;
      // pytest: `test_*` functions, and methods of `Test*` classes; unittest: methods of a `TestCase` subclass.
      const testClass = inClass && (/^Test/.test(chain[chain.length - 1] ?? "") || (classBases.get(inClass) ?? []).some((b) => /TestCase$/.test(b)));
      const testName = f.test && /^test/.test(name) && (!inClass || testClass);
      if (testName && (chain.length === 0 || inClass)) {
        const suite = inClass ? [chain[chain.length - 1]!] : [];
        tests.push({ id: `${f.path}#test:${[...suite, name].join(" > ")}`, name, suite, file: f.path, range: { start, end: endLineOf(def) } });
        return;
      }
      addSymbol({
        id, name, kind: inClass ? "method" : "function", file: f.path, range: { start, end: endLineOf(def) },
        exported: !name.startsWith("_") || /^__\w+__$/.test(name), parent,
      });
      const body = field(def, "body");
      if (body) for (const child of named(body)) if (child.type === "function_definition" || child.type === "decorated_definition" || child.type === "class_definition") define(child, [...chain, name], null, id);
    };

    for (const node of named(f.tree.rootNode)) {
      if (node.type === "function_definition" || node.type === "class_definition" || node.type === "decorated_definition") {
        define(node, [], null, null);
        continue;
      }
      if (node.type === "expression_statement") {
        const assign = named(node)[0];
        const left = assign?.type === "assignment" ? field(assign, "left") : null;
        if (assign && left?.type === "identifier" && left.text !== "__all__") {
          addSymbol({ id: `${f.path}#${left.text}`, name: left.text, kind: "const", file: f.path, range: { start: lineOf(node), end: endLineOf(node) }, exported: !left.text.startsWith("_"), parent: null });
        }
      }
    }

    // Imports anywhere in the file (inside functions too, and under `if TYPE_CHECKING:`).
    for (const node of f.tree.rootNode.descendantsOfType(["import_statement", "import_from_statement"])) {
      if (!node) continue;
      const line = lineOf(node);
      if (node.type === "import_statement") {
        for (const item of named(node)) {
          const dotted = item.type === "aliased_import" ? field(item, "name")!.text : item.text;
          const alias = item.type === "aliased_import" ? field(item, "alias")?.text : null;
          const hit = resolveModule(dotted);
          imports.push({ from: f.path, to: hit?.file ?? null, specifier: dotted, names: [alias ?? dotted], line, kind: "static", external: hit ? null : dotted.split(".")[0]!, confidence: "confirmed" });
          if (alias && hit) local.set(alias, { file: hit.file, name: null });
          // `import a.b` binds `a`; calls are written `a.b.f()`, resolved by their longest module prefix.
          if (!alias) local.set(`=${dotted}`, { file: hit?.file ?? "", name: null });
        }
        continue;
      }
      const modNode = field(node, "module_name");
      if (!modNode) continue;
      let mod = modNode.text;
      let relative = false;
      if (modNode.type === "relative_import") {
        relative = true;
        const dots = /^\.+/.exec(mod)![0].length;
        const base = pkg.split(".").filter(Boolean).slice(0, Math.max(0, pkg.split(".").filter(Boolean).length - (dots - 1)));
        const rest = mod.slice(dots);
        mod = [...base, ...(rest ? [rest] : [])].join(".");
      }
      const hit = mod ? resolveModule(mod) : null;
      const items = node.childrenForFieldName("name").filter((n): n is Node => !!n);
      const star = named(node).some((n) => n.type === "wildcard_import");
      const names: string[] = star ? ["*"] : [];
      for (const item of items) {
        const name = item.type === "aliased_import" ? field(item, "name")!.text : item.text;
        const alias = item.type === "aliased_import" ? field(item, "alias")!.text : name;
        names.push(name);
        // `from pkg import module` imports a submodule when there is one.
        const sub = resolveModule(mod ? `${mod}.${name}` : name);
        if (sub && (!hit || sub.file !== hit.file)) {
          local.set(alias, { file: sub.file, name: null });
          imports.push({ from: f.path, to: sub.file, specifier: `${mod}.${name}`, names: [alias], line, kind: "static", external: null, confidence: sub.confidence });
        } else if (hit) local.set(alias, { file: hit.file, name });
      }
      if (star && hit) starImports.set(f.path, [...(starImports.get(f.path) ?? []), hit.file]);
      if (hit || !items.length || !items.every((item) => resolveModule(`${mod}.${item.type === "aliased_import" ? field(item, "name")!.text : item.text}`))) {
        imports.push({
          from: f.path, to: hit?.file ?? null, specifier: modNode.text, names, line, kind: "static",
          external: hit || relative ? null : mod.split(".")[0]!, confidence: hit ? hit.confidence : relative ? "inferred" : "confirmed",
        });
      }
    }
  }

  // ---- name resolution
  const topLevel = (file: string, name: string): string | null => {
    const id = `${file}#${name}`;
    if (symbolIds.has(id)) return id;
    for (const star of starImports.get(file) ?? []) if (symbolIds.has(`${star}#${name}`)) return `${star}#${name}`;
    return null;
  };
  /** What a bare name means in a file: its own definition, or what it imported. Follows re-exports once. */
  const resolveName = (file: string, name: string, depth = 0): string | null => {
    const own = topLevel(file, name);
    if (own && !symbols.find((s) => s.id === own && s.kind === "const")) return own;
    const b = bindings.get(file)?.get(name);
    if (b?.name && depth < 3) return resolveName(b.file, b.name, depth + 1) ?? (symbolIds.has(`${b.file}#${b.name}`) ? `${b.file}#${b.name}` : null);
    return own;
  };
  const kindOf = (id: string) => symbols.find((s) => s.id === id)?.kind;
  const methodOf = (classId: string, name: string, seen = new Set<string>()): { id: string; inherited: boolean } | null => {
    if (symbolIds.has(`${classId}.${name}`)) return { id: `${classId}.${name}`, inherited: false };
    if (seen.has(classId)) return null;
    seen.add(classId);
    const file = classId.split("#")[0]!;
    for (const base of classBases.get(classId) ?? []) {
      const baseId = resolveName(file, base);
      const hit = baseId && kindOf(baseId) === "class" ? methodOf(baseId, name, seen) : null;
      if (hit) return { id: hit.id, inherited: true };
    }
    return null;
  };

  // ---- pass 2: edges
  const edges: EdgeFact[] = [];
  const seen = new Set<string>();
  const add = (from: string, target: Target, kind: EdgeFact["kind"], file: string, line: number) => {
    if (!target || from === target.id) return;
    const key = `${from}|${target.id}|${kind}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to: target.id, kind, file, line, confidence: target.confidence, ...(target.via ? { via: target.via } : {}) });
  };

  for (const f of files) {
    const local = bindings.get(f.path)!;
    /** Classes of variables, per scope: `x = Foo()`, `x: Foo`, and `self.x = Foo()` on the class. */
    const types = new Map<string, string>();

    const classOfExpr = (expr: Node | null, scope: string): { id: string; via: string } | null => {
      if (!expr) return null;
      if (expr.type === "call") {
        const fn = field(expr, "function");
        const t = fn ? resolveCallee(fn, scope, null) : null;
        if (t && kindOf(t.id) === "class") return { id: t.id, via: "class from the assignment" };
        return null;
      }
      if (expr.type === "identifier" || expr.type === "attribute") {
        const t = resolveCallee(expr, scope, null);
        if (t && kindOf(t.id) === "class") return { id: t.id, via: "class from the annotation" };
      }
      if (expr.type === "string" || expr.type === "type") return classOfExpr(named(expr)[0] ?? null, scope);
      return null;
    };

    /** What a callee expression leads to. `cls` is the enclosing class id, for `self.x`. */
    function resolveCallee(fn: Node, scope: string, cls: string | null): Target {
      if (fn.type === "identifier") {
        const name = fn.text;
        // A function defined in an enclosing function, then the module, then the imports.
        // A function defined inside the enclosing one, then the module, then the imports.
        if (symbolIds.has(`${scope}.${name}`) && kindOf(`${scope}.${name}`) === "function") return { id: `${scope}.${name}`, confidence: "confirmed" };
        const id = resolveName(f.path, name);
        return id ? { id, confidence: "confirmed" } : null;
      }
      if (fn.type !== "attribute") return null;
      const obj = field(fn, "object");
      const attr = field(fn, "attribute")?.text;
      if (!obj || !attr) return null;
      if (obj.type === "identifier" && (obj.text === "self" || obj.text === "cls") && cls) {
        const m = methodOf(cls, attr);
        if (m) return { id: m.id, confidence: m.inherited ? "inferred" : "confirmed", ...(m.inherited ? { via: "inherited from a base class" } : {}) };
      }
      // `pkg.mod.func()` after `import pkg.mod`: the longest module prefix.
      const dotted = fn.text.split(".");
      for (let n = dotted.length - 1; n >= 1; n--) {
        const b = local.get(`=${dotted.slice(0, n).join(".")}`);
        if (b?.file && n === dotted.length - 1) {
          const id = resolveName(b.file, attr);
          if (id) return { id, confidence: "confirmed" };
        }
      }
      if (obj.type === "identifier") {
        const b = local.get(obj.text);
        if (b && b.name === null) {
          const id = resolveName(b.file, attr);
          if (id) return { id, confidence: "confirmed" };
        }
        const named = resolveName(f.path, obj.text);
        if (named && kindOf(named) === "class") {
          const m = methodOf(named, attr);
          if (m) return { id: m.id, confidence: m.inherited ? "inferred" : "confirmed", ...(m.inherited ? { via: "inherited from a base class" } : {}) };
        }
      }
      // `Foo().method()`: the class is right there.
      if (obj.type === "call") {
        const made = classOfExpr(obj, scope);
        const m = made ? methodOf(made.id, attr) : null;
        if (m) return { id: m.id, confidence: "inferred", via: "class from the call" };
      }
      // A variable whose class is known from how it was made or annotated.
      const typed = types.get(`${scope}|${obj.text}`) ?? types.get(`${f.path}#<module>|${obj.text}`) ?? (cls ? types.get(`${cls}|${obj.text}`) : undefined) ?? types.get(`*|${obj.text}`);
      if (typed) {
        const [classId, via] = typed.split("\n");
        const m = methodOf(classId!, attr);
        if (m) return { id: m.id, confidence: "inferred", via: via! };
      }
      if (!BUILTIN_METHODS.has(attr) && !attr.startsWith("__")) {
        const same = methodsByName.get(attr) ?? [];
        if (same.length === 1) return { id: same[0]!, confidence: "inferred", via: "matched by method name" };
      }
      return null;
    }

    const childId = (scope: string, name: string) => (scope.endsWith("#<module>") ? `${f.path}#${name}` : `${scope}.${name}`);
    const visit = (node: Node, from: string, scope: string, cls: string | null) => {
      switch (node.type) {
        case "decorated_definition": {
          for (const d of named(node).filter((n) => n.type === "decorator")) visit(d, from, scope, cls);
          const def = field(node, "definition");
          if (def) visit(def, from, scope, cls);
          return;
        }
        case "class_definition": {
          const name = field(node, "name")?.text;
          const id = name ? childId(scope, name) : null;
          const classId = id && symbolIds.has(id) ? id : cls;
          for (const n of named(field(node, "superclasses") ?? node).filter((n) => n.type === "argument_list")) visit(n, from, scope, cls);
          const body = field(node, "body");
          if (body && classId) {
            // `self.x = Foo()` anywhere in the class gives `self.x` a class for every method.
            for (const a of body.descendantsOfType("assignment")) {
              const left = a && field(a, "left");
              if (a && left?.type === "attribute" && field(left, "object")?.text === "self") {
                const c = classOfExpr(field(a, "right") ?? field(a, "type"), classId);
                if (c) types.set(`${classId}|${left.text}`, `${c.id}\n${c.via}`);
              }
            }
            for (const child of named(body)) visit(child, classId, classId, classId);
          }
          return;
        }
        case "function_definition": {
          const name = field(node, "name")?.text;
          const id = name ? childId(scope, name) : null;
          const testId = tests.find((t) => t.file === f.path && t.range.end === endLineOf(node) && t.name === name)?.id;
          const own = testId ?? (id && symbolIds.has(id) ? id : from);
          const fnScope = id && symbolIds.has(id) ? id : testId ?? scope;
          for (const p of named(field(node, "parameters") ?? node)) {
            const pname = (p.type === "typed_parameter" ? named(p).find((n) => n.type === "identifier") : field(p, "name"))?.text;
            const c = pname ? classOfExpr(field(p, "type"), fnScope) : null;
            if (pname && c) types.set(`${fnScope}|${pname}`, `${c.id}\n${c.via}`);
          }
          const body = field(node, "body");
          if (body) for (const child of named(body)) visit(child, own, fnScope, cls && own.startsWith(cls) ? cls : null);
          return;
        }
        case "assignment": {
          const left = field(node, "left");
          if (left?.type === "identifier") {
            const c = classOfExpr(field(node, "right"), scope) ?? classOfExpr(field(node, "type"), scope);
            if (c) types.set(`${scope}|${left.text}`, `${c.id}\n${c.via}`);
          }
          break;
        }
        case "call": {
          const fn = field(node, "function");
          const target = fn ? resolveCallee(fn, scope, cls) : null;
          if (target) add(from, target, kindOf(target.id) === "class" ? "constructs" : "calls", f.path, lineOf(node));
          break;
        }
        case "decorator": {
          // `@cache` or `@retry(3)`: the decorator runs on the definition.
          const expr = named(node)[0];
          if (expr && expr.type !== "call") {
            const target = resolveCallee(expr, scope, cls);
            if (target) add(from, target, "calls", f.path, lineOf(node));
          }
          break;
        }
      }
      for (const child of named(node)) visit(child, from, scope, cls);
    };
    const moduleId = `${f.path}#<module>`;
    for (const child of named(f.tree.rootNode)) visit(child, moduleId, moduleId, null);
  }

  for (const f of files) f.tree.delete();
  for (const edge of edges) {
    if (edge.confidence === "confirmed" && !symbolIds.has(edge.to)) {
      edge.confidence = "inferred";
      edge.via = "target not in symbol table";
    }
  }
  return { symbols, edges, imports: dedupeImports(imports), tests, warnings };
}

function dedupeImports(imports: ImportFact[]): ImportFact[] {
  const seen = new Set<string>();
  return imports.filter((i) => {
    const key = `${i.from}|${i.to}|${i.specifier}|${i.line}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

