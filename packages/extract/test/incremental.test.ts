import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extract, type ExtractCache, type Facts } from "../src/index.ts";

const graph = (f: Facts) => ({ symbols: f.symbols, edges: f.edges, imports: f.imports, tests: f.tests, warnings: f.warnings, unreferenced: f.unreferenced });

describe("reading a repo again, incrementally", () => {
  it("gives the same graph as a full read after renames, new files, deletions and edits", async () => {
    const root = mkdtempSync(join(tmpdir(), "docent-incr-"));
    cpSync(join(import.meta.dirname, "fixture"), root, { recursive: true });
    const cache: ExtractCache = {};
    const first = await extract(root, { cache });
    // Page.tsx reaches upload() only through the lib/index.ts barrel.
    expect(first.edges.some((e) => e.file === "src/ui/Page.tsx" && e.to === "src/lib/upload.ts#upload")).toBe(true);

    const edit = (path: string, change: (text: string) => string) => writeFileSync(join(root, path), change(readFileSync(join(root, path), "utf8")));
    edit("src/lib/upload.ts", (t) => t.replace("export function upload(", "export function send("));
    edit("src/lib/api.ts", (t) => `// moved down a line\n${t}`);
    writeFileSync(join(root, "src/lib/extra.ts"), 'import { helper } from "./upload";\nexport const twice = () => helper(2);\n');
    rmSync(join(root, "src/orphan.ts"));

    const incremental = await extract(root, { cache });
    const full = await extract(root);
    expect(graph(incremental)).toEqual(graph(full));
    // The rename reached Page.tsx through the barrel: its link to upload() is gone, not left pointing at nothing.
    expect(incremental.edges.some((e) => e.to === "src/lib/upload.ts#upload")).toBe(false);
    expect(incremental.edges.some((e) => e.file === "src/lib/extra.ts" && e.to === "src/lib/upload.ts#helper")).toBe(true);

    // Nothing changed: still the same graph.
    expect(graph(await extract(root, { cache }))).toEqual(graph(full));
    // A config change builds the project afresh.
    edit("tsconfig.json", (t) => t.replace("{", '{\n  "//": "changed",'));
    expect(graph(await extract(root, { cache }))).toEqual(graph(await extract(root)));
  }, 60_000);
});
