import { createHighlighter, type Highlighter } from "shiki";

const LANGS = ["ts", "tsx", "js", "jsx", "json", "md", "html", "css", "vue", "yaml"] as const;
let instance: Promise<Highlighter> | null = null;

export const highlighter = () =>
  (instance ??= createHighlighter({ themes: ["github-light", "github-dark-default"], langs: [...LANGS] }));

export function langOf(path: string): string {
  const ext = path.split(".").pop() ?? "";
  const map: Record<string, string> = { mts: "ts", cts: "ts", mjs: "js", cjs: "js", mdx: "md", yml: "yaml" };
  const lang = map[ext] ?? ext;
  return (LANGS as readonly string[]).includes(lang) ? lang : "text";
}

/** Highlights lines and tags each with its real line number and whether it's in focus. */
export async function toHtml(lines: string[], path: string, start: number, focus: [number, number] | null): Promise<string> {
  const hl = await highlighter();
  return hl.codeToHtml(lines.join("\n"), {
    lang: langOf(path),
    themes: { light: "github-light", dark: "github-dark-default" },
    defaultColor: "light",
    transformers: [{
      line(node, i) {
        const n = start + i - 1;
        node.properties["data-line"] = n;
        if (focus && n >= focus[0] && n <= focus[1]) this.addClassToHast(node, "on");
      },
    }],
  });
}
