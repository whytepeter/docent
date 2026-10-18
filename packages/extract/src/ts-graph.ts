import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Node, Project, SyntaxKind, ts, type SourceFile } from "ts-morph";
import { isTestPath } from "./repo.ts";
import { autoImportNames, componentName, isViewPath, pascal, realPath, scriptView, sfcKind, templateRefs, viewPath } from "./sfc.ts";
import type { Confidence, EdgeFact, ImportFact, SymbolFact, SymbolKind, TestFact } from "./types.ts";

/** Wrappers whose function argument is still "the" named function: `const f = useCallback(() => …)`. */
const FN_WRAPPERS = new Set(["useCallback", "useMemo", "memo", "forwardRef", "useEffectEvent", "computed", "defineComponent"]);
const TEST_FNS = new Set(["it", "test"]);
const SUITE_FNS = new Set(["describe", "suite"]);

export interface Graph {
  symbols: SymbolFact[];
  edges: EdgeFact[];
  imports: ImportFact[];
  tests: TestFact[];
  warnings: string[];
}

export function loadProject(root: string, files: string[]): Project {
  const tsconfig = ["tsconfig.app.json", "tsconfig.json"].map((f) => join(root, f)).find(existsSync);
  const project = new Project({
    tsConfigFilePath: tsconfig,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.ReactJSX, noEmit: true },
  });
  for (const file of files) {
    // A Vue or Svelte component goes in as its script view, `Foo.vue.ts`, with its lines where they are in Foo.vue.
    if (sfcKind(file)) project.createSourceFile(viewPath(join(root, file)), scriptView(readFileSync(join(root, file), "utf8")), { overwrite: true });
    else project.addSourceFileAtPath(join(root, file));
  }
  project.resolveSourceFileDependencies();
  return project;
}

const packageOf = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);

function packageFromPath(path: string): string {
  const parts = path.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return "(lib)";
  const first = parts[at + 1] ?? "";
  return first.startsWith("@") ? `${first}/${parts[at + 2]}` : first;
}

function calleeName(call: Node): string | null {
  if (!Node.isCallExpression(call)) return null;
  const expr = call.getExpression();
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr)) {
    // `it.skip(...)`, `React.memo(...)`, `describe.each(...)` → the meaningful part
    const base = expr.getExpression();
    return Node.isIdentifier(base) && (TEST_FNS.has(base.getText()) || SUITE_FNS.has(base.getText())) ? base.getText() : expr.getName();
  }
  return null;
}

function unwrapExpressionParent(node: Node): Node | undefined {
  let parent = node.getParent();
  while (parent && (Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent) || Node.isSatisfiesExpression(parent))) {
    parent = parent.getParent();
  }
  return parent;
}

/** Name for a function-like node when it is a named unit a person would talk about. */
function functionName(node: Node): { name: string; anchor: Node } | null {
  if (Node.isFunctionDeclaration(node)) {
    const name = node.getName() ?? (node.isDefaultExport() ? "default" : null);
    return name ? { name, anchor: node } : null;
  }
  if (Node.isMethodDeclaration(node) || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
    return { name: node.getName(), anchor: node };
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    let parent = unwrapExpressionParent(node);
    if (parent && Node.isCallExpression(parent) && FN_WRAPPERS.has(calleeName(parent) ?? "")) {
      parent = unwrapExpressionParent(parent);
    }
    if (!parent) return null;
    if (Node.isVariableDeclaration(parent) && Node.isIdentifier(parent.getNameNode())) return { name: parent.getName(), anchor: parent };
    if (Node.isPropertyAssignment(parent) || Node.isPropertyDeclaration(parent)) return { name: parent.getName(), anchor: parent };
    if (Node.isExportAssignment(parent)) return { name: "default", anchor: parent };
  }
  return null;
}

function isExported(anchor: Node): boolean {
  if (Node.isVariableDeclaration(anchor)) return anchor.getVariableStatement()?.isExported() ?? false;
  if (Node.isExportAssignment(anchor)) return true;
  if (Node.isExportable(anchor)) return anchor.isExported();
  return false;
}

export function buildGraph(project: Project, root: string): Graph {
  const rel = (sf: SourceFile) => realPath(relative(root, sf.getFilePath()));
  const inRepo = (sf: SourceFile) => !sf.getFilePath().includes(`${sep}node_modules${sep}`) && !sf.isDeclarationFile() && sf.getFilePath().startsWith(root);

  const symbols: SymbolFact[] = [];
  const byNode = new Map<Node, string>(); // anchor and function nodes → symbol id
  const tests: TestFact[] = [];
  const testByCallback = new Map<Node, string>();
  const warnings: string[] = [];

  const repoFiles = project.getSourceFiles().filter(inRepo);

  // ---- pass 1: symbols and test cases
  for (const sf of repoFiles) {
    const file = rel(sf);
    const tsx = /\.[jt]sx$/.test(file);
    const testFile = isTestPath(file);

    sf.forEachDescendant((node) => {
      const named = functionName(node);
      if (named) {
        const chain: string[] = [named.name];
        for (const anc of node.getAncestors()) {
          const outer = Node.isClassDeclaration(anc) ? { name: anc.getName() ?? "default" } : functionName(anc);
          if (outer) chain.unshift(outer.name);
        }
        const id = `${file}#${chain.join(".")}`;
        if (!byNode.has(named.anchor)) {
          const parentChain = chain.slice(0, -1);
          const kind: SymbolKind = Node.isMethodDeclaration(node) || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)
            ? "method"
            : tsx && /^[A-Z]/.test(named.name) && parentChain.length === 0 ? "component" : "function";
          symbols.push({
            id, name: named.name, kind, file,
            range: { start: named.anchor.getStartLineNumber(), end: node.getEndLineNumber() },
            exported: isExported(named.anchor),
            parent: parentChain.length ? `${file}#${parentChain.join(".")}` : null,
          });
        }
        byNode.set(named.anchor, id);
        byNode.set(node, id);
        return;
      }
      if (Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node)) {
        const name = node.getName() ?? "default";
        const id = `${file}#${name}`;
        const kind: SymbolKind = Node.isClassDeclaration(node) ? "class" : Node.isInterfaceDeclaration(node) ? "interface" : "type";
        symbols.push({ id, name, kind, file, range: { start: node.getStartLineNumber(), end: node.getEndLineNumber() }, exported: node.isExported(), parent: null });
        byNode.set(node, id);
        return;
      }
      if (Node.isVariableDeclaration(node) && Node.isSourceFile(node.getVariableStatement()?.getParent() ?? node) && Node.isIdentifier(node.getNameNode())) {
        // Top-level non-function constants: configuration and data a reader needs to find.
        const id = `${file}#${node.getName()}`;
        symbols.push({ id, name: node.getName(), kind: "const", file, range: { start: node.getStartLineNumber(), end: node.getEndLineNumber() }, exported: isExported(node), parent: null });
        byNode.set(node, id);
      }
      if (testFile && Node.isCallExpression(node) && TEST_FNS.has(calleeName(node) ?? "")) {
        const [title, callback] = node.getArguments();
        if (!title || !callback || !(Node.isStringLiteral(title) || Node.isNoSubstitutionTemplateLiteral(title))) return;
        const suite = node.getAncestors()
          .filter((a): a is import("ts-morph").CallExpression => Node.isCallExpression(a) && SUITE_FNS.has(calleeName(a) ?? ""))
          .map((a) => a.getArguments()[0])
          .filter((a): a is import("ts-morph").StringLiteral => !!a && Node.isStringLiteral(a))
          .map((a) => a.getLiteralText())
          .reverse();
        const name = title.getLiteralText();
        const id = `${file}#test:${[...suite, name].join(" > ")}`;
        tests.push({ id, name, suite, file, range: { start: node.getStartLineNumber(), end: node.getEndLineNumber() } });
        testByCallback.set(callback, id);
      }
    });
  }
  // A Vue or Svelte component is one symbol for the whole file: its script's top level is the component's body.
  const components = new Map<string, string>(); // file → component symbol id
  for (const sf of repoFiles) {
    if (!isViewPath(sf.getFilePath())) continue;
    const file = rel(sf);
    const id = `${file}#${componentName(file)}`;
    components.set(file, id);
    if (!symbols.some((s) => s.id === id)) {
      symbols.push({ id, name: componentName(file), kind: "component", file, range: { start: 1, end: sf.getEndLineNumber() }, exported: true, parent: null });
    }
  }
  const symbolIds = new Set(symbols.map((s) => s.id));

  // ---- helpers for pass 2
  const enclosing = (node: Node, file: string): string => {
    for (const anc of node.getAncestors()) {
      const test = testByCallback.get(anc);
      if (test) return test;
      const fn = byNode.get(anc);
      if (fn && !Node.isVariableDeclaration(anc)) return fn;
      if (fn && Node.isVariableDeclaration(anc)) {
        const init = anc.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init) || Node.isCallExpression(init))) return fn;
      }
    }
    return components.get(file) ?? `${file}#<module>`;
  };

  type Target = { id: string; confidence: Confidence; via?: string } | null;
  const targetFromDeclaration = (decl: Node): Target => {
    const sf = decl.getSourceFile();
    if (!inRepo(sf)) return null; // packages, DOM and lib calls are not part of the map
    let node: Node | undefined = decl;
    if (Node.isShorthandPropertyAssignment(node)) {
      // `return { mutate }` → the local `mutate` function
      const defs = node.getNameNode().getDefinitionNodes().filter((d) => d !== node);
      node = defs[0] ?? node;
    }
    if (Node.isPropertyAssignment(node)) {
      const init = node.getInitializer();
      if (init && Node.isIdentifier(init)) {
        const decls = init.getSymbol()?.getDeclarations() ?? [];
        if (decls[0]) node = decls[0];
      }
    }
    const id = byNode.get(node) ?? (Node.isVariableDeclaration(node) ? byNode.get(node) : undefined);
    if (id) return { id, confidence: "confirmed" };
    // `import Foo from "./Foo.vue"`: the component itself (a `<script setup>` has no default export to point at).
    const component = components.get(rel(sf));
    if (component && (Node.isSourceFile(node) || Node.isExportAssignment(node))) return { id: component, confidence: "confirmed" };
    if (Node.isPropertySignature(node) || Node.isMethodSignature(node)) {
      const owner = node.getParent();
      const ownerName = owner && (Node.isInterfaceDeclaration(owner) ? owner.getName() : Node.isTypeLiteral(owner) ? owner.getParent()?.getSymbol()?.getName() : undefined);
      return { id: `${realPath(relative(root, sf.getFilePath()))}#${ownerName ?? "?"}.${node.getName()}`, confidence: "inferred", via: "interface member; implementation not traced" };
    }
    return null;
  };

  const resolve = (expr: Node): Target => {
    let symbol = expr.getSymbol();
    if (!symbol) return null;
    if (symbol.isAlias()) symbol = symbol.getAliasedSymbol() ?? symbol;
    for (const decl of symbol.getDeclarations()) {
      if (Node.isParameterDeclaration(decl) || Node.isBindingElement(decl)) return null; // callbacks passed in: no fixed target
      const target = targetFromDeclaration(decl);
      if (target) return target;
    }
    // A property on a value whose type the checker resolves through ReturnType<...> etc.: try go-to-definition.
    if (Node.isPropertyAccessExpression(expr)) {
      for (const def of expr.getNameNode().getDefinitionNodes()) {
        const target = targetFromDeclaration(def);
        if (target) return target;
      }
    }
    return null;
  };

  // ---- pass 2: edges and imports
  const edges: EdgeFact[] = [];
  const seen = new Set<string>();
  const imports: ImportFact[] = [];

  for (const sf of repoFiles) {
    const file = rel(sf);

    for (const decl of sf.getImportDeclarations()) {
      const spec = decl.getModuleSpecifierValue();
      const target = decl.getModuleSpecifierSourceFile();
      const names = [
        ...(decl.getDefaultImport() ? [decl.getDefaultImport()!.getText()] : []),
        ...(decl.getNamespaceImport() ? [`* as ${decl.getNamespaceImport()!.getText()}`] : []),
        ...decl.getNamedImports().map((n) => n.getName()),
      ];
      const local = target && inRepo(target);
      const relativeSpec = spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/") || spec.startsWith("~/");
      const asset = !target && relativeSpec ? assetPath(root, file, spec) : null;
      imports.push({
        from: file,
        to: local ? rel(target) : asset,
        specifier: spec,
        names,
        line: decl.getStartLineNumber(),
        kind: decl.isTypeOnly() ? "type" : "static",
        external: local || relativeSpec ? null : packageOf(spec),
        confidence: local || asset || !relativeSpec ? "confirmed" : "inferred",
      });
    }
    for (const decl of sf.getExportDeclarations()) {
      const spec = decl.getModuleSpecifierValue();
      if (!spec) continue;
      const target = decl.getModuleSpecifierSourceFile();
      imports.push({
        from: file, to: target && inRepo(target) ? rel(target) : null, specifier: spec,
        names: decl.getNamedExports().map((n) => n.getName()), line: decl.getStartLineNumber(),
        kind: "reexport", external: target && inRepo(target) ? null : spec.startsWith(".") ? null : packageOf(spec),
        confidence: target ? "confirmed" : "inferred",
      });
    }

    sf.forEachDescendant((node) => {
      let targetExpr: Node | undefined;
      let kind: EdgeFact["kind"] = "calls";
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (expr.getKind() === SyntaxKind.ImportKeyword) {
          const arg = node.getArguments()[0];
          const spec = arg && Node.isStringLiteral(arg) ? arg.getLiteralText() : arg?.getText() ?? "?";
          imports.push({ from: file, to: null, specifier: spec, names: [], line: node.getStartLineNumber(), kind: "dynamic", external: null, confidence: "inferred" });
          return;
        }
        targetExpr = expr;
      } else if (Node.isNewExpression(node)) {
        targetExpr = node.getExpression();
        kind = "constructs";
      } else if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
        targetExpr = node.getTagNameNode();
        kind = "renders";
      }
      if (!targetExpr) return;
      let target: Target = null;
      try {
        target = resolve(targetExpr);
      } catch (error) {
        warnings.push(`${file}:${node.getStartLineNumber()} could not resolve ${targetExpr.getText().slice(0, 40)}: ${(error as Error).message.slice(0, 80)}`);
      }
      if (!target) return;
      const from = enclosing(node, file);
      if (from === target.id) return; // recursion is noise at this level
      const line = node.getStartLineNumber();
      const key = `${from}|${target.id}|${kind}|${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from, to: target.id, kind, file, line, confidence: target.confidence, ...(target.via ? { via: target.via } : {}) });
    });
  }

  templateEdges(root, repoFiles.filter((sf) => isViewPath(sf.getFilePath())).map(rel), components, symbols, imports, edges, seen);

  for (const edge of edges) {
    if (edge.confidence === "confirmed" && !symbolIds.has(edge.to)) {
      edge.confidence = "inferred";
      edge.via = "target not in symbol table";
    }
  }
  return { symbols, edges, imports, tests, warnings };
}

function assetPath(root: string, from: string, spec: string): string | null {
  const base = spec.startsWith("@/") || spec.startsWith("~/") ? join(root, "src", spec.slice(2)) : spec.startsWith("/") ? join(root, spec) : join(root, from, "..", spec);
  return existsSync(base) ? relative(root, base) : null;
}

/**
 * What a component's template does, as edges: the components it renders (through its imports, or by name for
 * auto-imported ones, as Nuxt and unplugin-vue-components do), and the script functions its handlers and
 * bindings use.
 */
function templateEdges(root: string, files: string[], components: Map<string, string>, symbols: SymbolFact[], imports: ImportFact[], edges: EdgeFact[], seen: Set<string>): void {
  const byName = new Map<string, string[]>(); // component name → component ids, for auto-imports
  for (const [file, id] of components) {
    for (const name of autoImportNames(file)) byName.set(name, [...(byName.get(name) ?? []), id]);
  }
  const add = (edge: EdgeFact) => {
    const key = `${edge.from}|${edge.to}|${edge.kind}|${edge.line}`;
    if (seen.has(key) || edge.from === edge.to) return;
    seen.add(key);
    edges.push(edge);
  };
  for (const file of files) {
    const kind = sfcKind(file)!;
    const from = components.get(file)!;
    const { tags, names } = templateRefs(kind, readFileSync(join(root, file), "utf8"));
    // Local names this file imports, and where they lead.
    const imported = new Map<string, string>();
    for (const imp of imports) {
      if (imp.from !== file || !imp.to) continue;
      for (const n of imp.names) imported.set(n, imp.to);
    }
    const target = (name: string): string | null => {
      const to = imported.get(name);
      if (to) return components.get(to) ?? symbols.find((s) => s.file === to && (s.name === name || s.kind === "component") && !s.parent)?.id ?? null;
      return null;
    };
    for (const tag of tags) {
      if (/^[a-z]+$/.test(tag.name) && !tag.name.includes("-")) continue; // plain HTML elements
      const name = tag.name.includes("-") || /^[a-z]/.test(tag.name) ? pascal(tag.name) : tag.name.split(".")[0]!;
      const direct = target(tag.name) ?? target(name);
      if (direct) {
        add({ from, to: direct, kind: "renders", file, line: tag.line, confidence: "confirmed" });
        continue;
      }
      const byFile = byName.get(name) ?? [];
      if (byFile.length === 1) add({ from, to: byFile[0]!, kind: "renders", file, line: tag.line, confidence: "inferred", via: "not imported; matched by file name (auto-imported component)" });
    }
    // Script functions the template uses: `@click="save"`, `on:click={save}`, `{format(date)}`.
    const own = new Map(symbols.filter((s) => s.file === file && !s.parent && (s.kind === "function" || s.kind === "method")).map((s) => [s.name, s.id]));
    for (const n of names) {
      const to = own.get(n.name) ?? (imported.has(n.name) ? target(n.name) : null);
      if (to && to !== from) add({ from, to, kind: "calls", file, line: n.line, confidence: "confirmed", via: "used in the template" });
    }
  }
}
