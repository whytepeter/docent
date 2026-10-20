import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";

/**
 * Tree-sitter, compiled to WebAssembly, for the languages the TypeScript compiler can't read. The grammars
 * are prebuilt `.wasm` files that ship with Docent (`grammars/`, next to `src/` in a checkout and next to
 * `docent.js` once built), so nothing is compiled on install and no Python or Go toolchain is needed.
 */

export type TreeLang = "python" | "go";
export type { Node, Tree };

const grammarDir = (): string => {
  for (const rel of ["../grammars/", "./grammars/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(`${dir}tree-sitter-python.wasm`)) return dir;
  }
  throw new Error("Docent's tree-sitter grammars are missing (grammars/tree-sitter-*.wasm)");
};

let ready: Promise<Record<TreeLang, Parser>> | null = null;

/** One parser per language, loaded once. */
export function parsers(): Promise<Record<TreeLang, Parser>> {
  return (ready ??= (async () => {
    await Parser.init();
    const dir = grammarDir();
    const make = async (lang: TreeLang) => {
      const parser = new Parser();
      parser.setLanguage(await Language.load(`${dir}tree-sitter-${lang}.wasm`));
      return parser;
    };
    return { python: await make("python"), go: await make("go") };
  })());
}

/** 1-based lines, as every fact carries them. */
export const lineOf = (node: Node) => node.startPosition.row + 1;
export const endLineOf = (node: Node) => node.endPosition.row + 1;

export const named = (node: Node): Node[] => node.namedChildren.filter((n): n is Node => !!n);
export const field = (node: Node, name: string): Node | null => node.childForFieldName(name);
