import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { goModule } from "./manifests.ts";
import type { Graph } from "./ts-graph.ts";
import { endLineOf, field, lineOf, named, type Node, type Tree } from "./trees.ts";
import type { Parser } from "web-tree-sitter";
import type { Confidence, EdgeFact, ImportFact, SymbolFact, TestFact } from "./types.ts";

/**
 * Go's call graph, read from the syntax tree. A package is a folder, so a bare call reaches any file in it,
 * and `pkg.Func()` reaches the imported folder (through go.mod's module path). Go is statically typed, so a
 * method call is confirmed when the receiver's type is written in the code: the method's receiver, a
 * parameter, `var x T`, `x := T{}`, or `x := pkg.New()` whose declared result is `*T`. A call through an
 * interface is inferred (the implementation isn't traced), and so is a method matched by its name alone.
 */

interface GoFile {
  path: string;
  dir: string;
  pkg: string;
  tree: Tree;
  test: boolean;
}

/** A type as written: `*store.Store` → { pkgDir: "internal/store", name: "Store" }. */
interface TypeRef {
  dir: string;
  name: string;
}

type Target = { id: string; confidence: Confidence; via?: string } | null;

const COMMON_METHODS = new Set(["Error", "String", "Close", "Read", "Write", "Run", "Get", "Set", "Len", "Next", "Scan", "Do", "Wait", "Lock", "Unlock"]);

export function buildGoGraph(root: string, paths: string[], parser: Parser): Graph {
  const warnings: string[] = [];
  const files: GoFile[] = [];
  for (const path of paths) {
    const tree = parser.parse(readFileSync(join(root, path), "utf8"));
    if (!tree) {
      warnings.push(`${path}: could not be parsed`);
      continue;
    }
    const pkg = named(tree.rootNode).find((n) => n.type === "package_clause");
    files.push({ path, dir: posix.dirname(path), pkg: pkg ? named(pkg)[0]?.text ?? "" : "", tree, test: path.endsWith("_test.go") });
  }
  // The repo's own packages are imported under go.mod's module path.
  const modules: { prefix: string; module: string }[] = [];
  const { module } = goModule(root);
  if (module) modules.push({ prefix: "", module });
  const dirOfImport = (spec: string): string | null => {
    for (const m of modules) {
      if (spec === m.module) return m.prefix || ".";
      if (spec.startsWith(`${m.module}/`)) return posix.join(m.prefix || ".", spec.slice(m.module.length + 1));
    }
    return null;
  };
  const filesIn = new Map<string, GoFile[]>();
  for (const f of files) filesIn.set(f.dir, [...(filesIn.get(f.dir) ?? []), f]);

  const symbols: SymbolFact[] = [];
  const tests: TestFact[] = [];
  const imports: ImportFact[] = [];
  /** Package-level names per folder: `dir|Name` → symbol id. Methods: `dir|Type.Method`. */
  const decls = new Map<string, string>();
  const kinds = new Map<string, SymbolFact["kind"]>();
  const fields = new Map<string, Map<string, Node>>(); // struct id → field → type node
  const results = new Map<string, Node[]>(); // function or method id → result type nodes
  const methodsByName = new Map<string, string[]>();
  const fileOfDecl = new Map<string, GoFile>();
  /** Per file: local package name → imported folder. */
  const importsOf = new Map<string, Map<string, string>>();

  const add = (f: GoFile, key: string, s: SymbolFact) => {
    if (kinds.has(s.id)) return;
    symbols.push(s);
    kinds.set(s.id, s.kind);
    decls.set(`${f.dir}|${key}`, s.id);
    fileOfDecl.set(s.id, f);
    if (s.kind === "method") methodsByName.set(s.name, [...(methodsByName.get(s.name) ?? []), s.id]);
  };
  const resultTypes = (fn: Node): Node[] => {
    const r = field(fn, "result");
    if (!r) return [];
    return r.type === "parameter_list" ? named(r).map((p) => field(p, "type")).filter((n): n is Node => !!n) : [r];
  };
  const receiverType = (fn: Node): string | null => {
    const recv = field(fn, "receiver");
    const param = recv ? named(recv)[0] : null;
    let type = param ? field(param, "type") : null;
    while (type && (type.type === "pointer_type" || type.type === "generic_type")) type = type.type === "generic_type" ? field(type, "type") : named(type)[0] ?? null;
    return type?.text ?? null;
  };

  // ---- pass 1: declarations, tests, imports
  for (const f of files) {
    const local = new Map<string, string>();
    importsOf.set(f.path, local);
    for (const spec of f.tree.rootNode.descendantsOfType("import_spec")) {
      if (!spec) continue;
      const path = field(spec, "path")?.text.slice(1, -1) ?? "";
      const alias = field(spec, "name")?.text;
      const dir = dirOfImport(path);
      const targets = dir ? (filesIn.get(dir) ?? []).filter((t) => !t.test) : [];
      const localName = alias ?? targets[0]?.pkg ?? path.split("/").pop()!.replace(/^go-|\.v\d+$/g, "");
      if (dir && targets.length && alias !== "_") local.set(localName, dir);
      const line = lineOf(spec);
      if (!targets.length) {
        imports.push({ from: f.path, to: null, specifier: path, names: [localName], line, kind: "static", external: dir ? null : path, confidence: dir ? "inferred" : "confirmed" });
      }
      // A Go import brings in the whole folder: one fact per file in it.
      for (const t of targets) imports.push({ from: f.path, to: t.path, specifier: path, names: [localName], line, kind: "static", external: null, confidence: "confirmed" });
    }

    for (const node of named(f.tree.rootNode)) {
      const range = { start: lineOf(node), end: endLineOf(node) };
      if (node.type === "function_declaration") {
        const name = field(node, "name")?.text;
        if (!name) continue;
        const params = field(node, "parameters")?.text ?? "";
        if (f.test && /^(Test|Fuzz|Benchmark|Example)/.test(name) && (/^Example/.test(name) || /\*testing\.[TFB]\b/.test(params))) {
          tests.push({ id: `${f.path}#test:${name}`, name, suite: [], file: f.path, range });
          // Subtests: `t.Run("name", func(t *testing.T) { ... })`.
          for (const call of node.descendantsOfType("call_expression")) {
            const fn = call && field(call, "function");
            const args = call ? named(field(call, "arguments") ?? call) : [];
            if (call && fn?.type === "selector_expression" && field(fn, "field")?.text === "Run" && args[0]?.type === "interpreted_string_literal" && args[1]?.type === "func_literal") {
              const sub = args[0].text.slice(1, -1);
              tests.push({ id: `${f.path}#test:${name} > ${sub}`, name: sub, suite: [name], file: f.path, range: { start: lineOf(call), end: endLineOf(call) } });
            }
          }
          continue;
        }
        const id = `${f.path}#${name}`;
        add(f, name, { id, name, kind: "function", file: f.path, range, exported: /^[A-Z]/.test(name), parent: null });
        results.set(id, resultTypes(node));
      } else if (node.type === "method_declaration") {
        const name = field(node, "name")?.text;
        const recv = receiverType(node);
        if (!name || !recv) continue;
        const id = `${f.path}#${recv}.${name}`;
        const owner = decls.get(`${f.dir}|${recv}`);
        add(f, `${recv}.${name}`, { id, name, kind: "method", file: f.path, range, exported: /^[A-Z]/.test(name), parent: owner && owner.startsWith(`${f.path}#`) ? owner : null });
        results.set(id, resultTypes(node));
      } else if (node.type === "type_declaration") {
        for (const spec of named(node).filter((n) => n.type === "type_spec" || n.type === "type_alias")) {
          const name = field(spec, "name")?.text;
          const type = field(spec, "type");
          if (!name) continue;
          const id = `${f.path}#${name}`;
          const kind = type?.type === "struct_type" ? "class" : type?.type === "interface_type" ? "interface" : "type";
          add(f, name, { id, name, kind, file: f.path, range: { start: lineOf(spec), end: endLineOf(spec) }, exported: /^[A-Z]/.test(name), parent: null });
          if (type?.type === "struct_type") {
            const map = new Map<string, Node>();
            for (const fd of type.descendantsOfType("field_declaration")) {
              const t = fd && field(fd, "type");
              if (!fd || !t) continue;
              const names = fd.childrenForFieldName("name").filter((n): n is Node => !!n);
              if (names.length) for (const n of names) map.set(n.text, t);
              else map.set(t.text.replace(/^\*/, "").split(".").pop()!, t); // embedded field
            }
            fields.set(id, map);
          }
          if (type?.type === "interface_type") {
            for (const m of named(type).filter((n) => n.type === "method_elem" || n.type === "method_spec")) {
              const mname = field(m, "name")?.text;
              if (mname) decls.set(`${f.dir}|${name}.${mname}`, `${id}.${mname}`);
            }
          }
        }
      } else if (node.type === "const_declaration" || node.type === "var_declaration") {
        for (const spec of node.descendantsOfType(["const_spec", "var_spec"])) {
          if (!spec || spec.parent?.type === "block") continue;
          for (const n of spec.childrenForFieldName("name").filter((n): n is Node => !!n)) {
            add(f, n.text, { id: `${f.path}#${n.text}`, name: n.text, kind: "const", file: f.path, range: { start: lineOf(spec), end: endLineOf(spec) }, exported: /^[A-Z]/.test(n.text), parent: null });
          }
        }
      }
    }
  }
  // Methods declared before their type in the same file get their parent now.
  for (const s of symbols) {
    if (s.kind !== "method" || s.parent) continue;
    const owner = s.id.split("#")[1]!.split(".")[0]!;
    if (kinds.has(`${s.file}#${owner}`)) s.parent = `${s.file}#${owner}`;
  }

  // ---- types of expressions
  const typeRef = (type: Node | null, f: GoFile): TypeRef | null => {
    while (type && (type.type === "pointer_type" || type.type === "parenthesized_type")) type = named(type)[0] ?? null;
    if (!type) return null;
    if (type.type === "generic_type") return typeRef(field(type, "type"), f);
    if (type.type === "type_identifier") return { dir: f.dir, name: type.text };
    if (type.type === "qualified_type") {
      const dir = importsOf.get(f.path)?.get(field(type, "package")?.text ?? "");
      const name = field(type, "name")?.text;
      return dir && name ? { dir, name } : null;
    }
    return null;
  };
  const typeId = (t: TypeRef | null) => (t ? decls.get(`${t.dir}|${t.name}`) ?? null : null);
  const methodOn = (t: TypeRef, name: string, seen = new Set<string>()): { id: string; iface: boolean } | null => {
    const id = decls.get(`${t.dir}|${t.name}.${name}`);
    const owner = typeId(t);
    if (id) return { id, iface: !!owner && kinds.get(owner) === "interface" };
    // A method promoted from an embedded struct.
    if (!owner || seen.has(owner)) return null;
    seen.add(owner);
    const ownerFile = fileOfDecl.get(owner);
    for (const [fname, ftype] of fields.get(owner) ?? []) {
      const ref = ownerFile ? typeRef(ftype, ownerFile) : null;
      if (ref && ref.name === fname) {
        const hit = methodOn(ref, name, seen);
        if (hit) return hit;
      }
    }
    return null;
  };

  // ---- pass 2: edges
  const edges: EdgeFact[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, target: Target, kind: EdgeFact["kind"], file: string, line: number) => {
    if (!target || from === target.id) return;
    const key = `${from}|${target.id}|${kind}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to: target.id, kind, file, line, confidence: target.confidence, ...(target.via ? { via: target.via } : {}) });
  };

  for (const f of files) {
    const pkgs = importsOf.get(f.path)!;
    /** Variables' types inside the current top-level function (closures share it). */
    let vars = new Map<string, TypeRef>();

    const exprType = (expr: Node | null): TypeRef | null => {
      if (!expr) return null;
      switch (expr.type) {
        case "identifier":
          return vars.get(expr.text) ?? null;
        case "unary_expression":
        case "parenthesized_expression":
          return exprType(field(expr, "operand") ?? named(expr)[0] ?? null);
        case "composite_literal":
          return typeRef(field(expr, "type"), f);
        case "selector_expression": {
          const base = exprType(field(expr, "operand"));
          const owner = typeId(base);
          const fd = owner ? fields.get(owner)?.get(field(expr, "field")?.text ?? "") : undefined;
          const ownerFile = owner ? fileOfDecl.get(owner) : undefined;
          return fd && ownerFile ? typeRef(fd, ownerFile) : null;
        }
        case "call_expression": {
          const callee = field(expr, "function");
          const t = callee ? resolve(callee) : null;
          const r = t ? results.get(t.id)?.[0] : undefined;
          const owner = t ? fileOfDecl.get(t.id) : undefined;
          return r && owner ? typeRef(r, owner) : null;
        }
      }
      return null;
    };

    function resolve(fn: Node): Target {
      if (fn.type === "identifier") {
        const id = decls.get(`${f.dir}|${fn.text}`);
        return id && kinds.get(id) !== "const" ? { id, confidence: "confirmed" } : null;
      }
      if (fn.type === "parenthesized_expression") return resolve(named(fn)[0]!);
      if (fn.type !== "selector_expression") return null;
      const operand = field(fn, "operand");
      const name = field(fn, "field")?.text;
      if (!operand || !name) return null;
      if (operand.type === "identifier" && !vars.has(operand.text) && pkgs.has(operand.text)) {
        const id = decls.get(`${pkgs.get(operand.text)}|${name}`);
        return id && kinds.get(id) !== "const" ? { id, confidence: "confirmed" } : null;
      }
      const t = exprType(operand);
      if (t) {
        const m = methodOn(t, name);
        if (m) return m.iface ? { id: m.id, confidence: "inferred", via: "interface member; implementation not traced" } : { id: m.id, confidence: "confirmed" };
        if (typeId(t)) return null; // a field holding a func, or a method of an outside type
      }
      if (!COMMON_METHODS.has(name)) {
        const same = methodsByName.get(name) ?? [];
        if (same.length === 1) return { id: same[0]!, confidence: "inferred", via: "matched by method name" };
      }
      return null;
    }

    const bindParams = (params: Node | null) => {
      for (const p of params ? named(params) : []) {
        const t = typeRef(field(p, "type"), f);
        if (!t) continue;
        for (const n of p.childrenForFieldName("name").filter((n): n is Node => !!n)) vars.set(n.text, t);
      }
    };

    const visit = (node: Node, from: string) => {
      switch (node.type) {
        case "func_literal":
          bindParams(field(node, "parameters"));
          break;
        case "short_var_declaration":
        case "assignment_statement": {
          const left = named(field(node, "left") ?? node);
          const right = named(field(node, "right") ?? node);
          if (right.length === left.length) left.forEach((l, i) => {
            const t = exprType(right[i]!);
            if (l.type === "identifier" && t) vars.set(l.text, t);
          });
          else if (right.length === 1 && right[0]!.type === "call_expression") {
            // `x, err := pkg.Load()`: each name takes its result's declared type.
            const callee = field(right[0]!, "function");
            const t = callee ? resolve(callee) : null;
            const owner = t ? fileOfDecl.get(t.id) : undefined;
            (t ? results.get(t.id) ?? [] : []).forEach((r, i) => {
              const ref = owner ? typeRef(r, owner) : null;
              if (left[i]?.type === "identifier" && ref) vars.set(left[i]!.text, ref);
            });
          }
          break;
        }
        case "var_spec": {
          const t = typeRef(field(node, "type"), f) ?? exprType(named(field(node, "value") ?? node)[0] ?? null);
          if (t) for (const n of node.childrenForFieldName("name").filter((n): n is Node => !!n)) vars.set(n.text, t);
          break;
        }
        case "call_expression": {
          // A subtest's body belongs to the subtest.
          const fn = field(node, "function");
          const args = named(field(node, "arguments") ?? node);
          if (fn?.type === "selector_expression" && field(fn, "field")?.text === "Run" && args[0]?.type === "interpreted_string_literal" && args[1]?.type === "func_literal" && from.includes("#test:")) {
            const sub = `${from.split(" > ")[0]} > ${args[0].text.slice(1, -1)}`;
            if (tests.some((t) => t.id === sub)) {
              visit(args[1], sub);
              return;
            }
          }
          const target = fn ? resolve(fn) : null;
          if (target) addEdge(from, target, kinds.get(target.id) === "class" ? "constructs" : "calls", f.path, lineOf(node));
          break;
        }
        case "composite_literal": {
          const id = typeId(typeRef(field(node, "type"), f));
          if (id && kinds.get(id) === "class") addEdge(from, { id, confidence: "confirmed" }, "constructs", f.path, lineOf(node));
          break;
        }
      }
      for (const child of named(node)) visit(child, from);
    };

    for (const node of named(f.tree.rootNode)) {
      vars = new Map();
      if (node.type === "function_declaration" || node.type === "method_declaration") {
        const name = field(node, "name")?.text ?? "";
        const recv = node.type === "method_declaration" ? receiverType(node) : null;
        const test = tests.find((t) => t.id === `${f.path}#test:${name}`);
        const from = test?.id ?? `${f.path}#${recv ? `${recv}.` : ""}${name}`;
        if (recv) {
          const param = named(field(node, "receiver")!)[0];
          const rname = param ? field(param, "name")?.text : null;
          if (rname) vars.set(rname, { dir: f.dir, name: recv });
        }
        bindParams(field(node, "parameters"));
        const body = field(node, "body");
        if (body) visit(body, from);
      } else if (node.type === "var_declaration" || node.type === "const_declaration") {
        visit(node, `${f.path}#<module>`);
      }
    }
  }

  for (const f of files) f.tree.delete();
  return { symbols, edges, imports, tests, warnings };
}
