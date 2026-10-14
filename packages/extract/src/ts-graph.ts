import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Node, Project, SyntaxKind, ts, type SourceFile } from "ts-morph";
import { isTestPath } from "./repo.ts";
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
  for (const file of files) project.addSourceFileAtPath(join(root, file));
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
  const rel = (sf: SourceFile) => relative(root, sf.getFilePath());
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
    return `${file}#<module>`;
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
    if (Node.isPropertySignature(node) || Node.isMethodSignature(node)) {
      const owner = node.getParent();
      const ownerName = owner && (Node.isInterfaceDeclaration(owner) ? owner.getName() : Node.isTypeLiteral(owner) ? owner.getParent()?.getSymbol()?.getName() : undefined);
      return { id: `${relative(root, sf.getFilePath())}#${ownerName ?? "?"}.${node.getName()}`, confidence: "inferred", via: "interface member; implementation not traced" };
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
