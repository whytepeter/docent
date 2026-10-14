import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findDuplicates, type FileFact, type SymbolFact } from "../src/index.ts";

const LOGIC = (name: string, v: string) => `export async function ${name}(items: string[]) {
  const out: string[] = [];
  for (const ${v} of items) {
    if (!${v}) continue;
    const trimmed = ${v}.trim();
    // keep the first ten
    if (out.length < 10) out.push(trimmed);
  }
  await Promise.resolve();
  out.sort();
  return out;
}
`;
const WRAPPER = (name: string, key: string) => `export function ${name}({ onStart }: Props) {
  return (
    <Intro
      actionKey="${key}.action"
      descriptionKey="${key}.description"
      onStart={onStart}
      icon="${key}"
      labelKey="${key}.label"
      titleKey="${key}.title"
      extra="${key}"
    />
  );
}
`;

function setup(sources: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "docent-dups-"));
  const files: FileFact[] = [];
  const symbols: SymbolFact[] = [];
  for (const [path, text] of Object.entries(sources)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
    const lines = text.split("\n").length - 1;
    files.push({ path, kind: "source", lang: "tsx", lines, hash: path });
    const name = /function (\w+)/.exec(text)![1]!;
    symbols.push({ id: `${path}#${name}`, name, kind: "function", file: path, range: { start: 1, end: lines }, exported: true, parent: null });
  }
  return findDuplicates(root, files, symbols);
}

describe("duplicate code", () => {
  it("finds a copied function (exact, confirmed) and a renamed copy (shape, inferred)", () => {
    const out = setup({
      "a/clean.ts": LOGIC("cleanA", "item"),
      "b/clean.ts": LOGIC("cleanB", "item"),
      "c/tidy.ts": LOGIC("tidy", "entry"),
    });
    expect(out.map((d) => [d.kind, d.confidence, d.members.length])).toEqual([["exact", "confirmed", 2]]);
  });
  it("calls a renamed copy 'shape' when no exact copy exists", () => {
    const out = setup({ "a/clean.ts": LOGIC("cleanA", "item"), "c/tidy.ts": LOGIC("tidy", "entry") });
    expect(out.map((d) => [d.kind, d.confidence])).toEqual([["shape", "inferred"]]);
  });
  it("ignores thin wrappers that configure one shared component", () => {
    expect(setup({ "a/One.tsx": WRAPPER("One", "one"), "b/Two.tsx": WRAPPER("Two", "two") })).toEqual([]);
  });
});
