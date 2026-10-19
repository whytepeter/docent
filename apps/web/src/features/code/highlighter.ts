import { createHighlighter, type BundledTheme, type Highlighter } from "shiki";
import { editorThemeStore } from "./editor-theme.ts";

const LANGS = ["ts", "tsx", "js", "jsx", "json", "md", "html", "css", "vue", "svelte", "yaml", "python", "go", "toml", "ini", "shellscript"] as const;
let instance: Promise<Highlighter> | null = null;

export const highlighter = () =>
  (instance ??= createHighlighter({ themes: ["github-light", "github-dark-default"], langs: [...LANGS] }));

export function langOf(path: string): string {
  const ext = path.split(".").pop() ?? "";
  const map: Record<string, string> = { mts: "ts", cts: "ts", mjs: "js", cjs: "js", mdx: "md", yml: "yaml", py: "python", pyi: "python", cfg: "ini", sh: "shellscript" };
  const lang = map[ext] ?? ext;
  return (LANGS as readonly string[]).includes(lang) ? lang : "text";
}

/** Makes sure a theme is loaded in the highlighter (themes are fetched on first use). */
export async function loadEditorTheme(id: BundledTheme): Promise<Highlighter> {
  const hl = await highlighter();
  if (!hl.getLoadedThemes().includes(id)) await hl.loadTheme(id);
  return hl;
}

/** The chosen editor theme, loaded, with code surfaces painted in its background, text and line-number colours. */
export async function editorTheme(): Promise<BundledTheme> {
  const id = editorThemeStore.get();
  const t = (await loadEditorTheme(id)).getTheme(id);
  const st = document.documentElement.style;
  st.setProperty("--editor-bg", t.bg);
  st.setProperty("--editor-fg", t.fg);
  st.setProperty("--editor-mut", t.colors?.["editorLineNumber.foreground"] ?? `color-mix(in srgb, ${t.fg} 45%, ${t.bg})`);
  // What sits on top of the code: highlighted lines, rules between parts, and scrollbars, for a dark or a light editor.
  const light = t.type === "light";
  st.setProperty("--editor-hot", light ? `color-mix(in srgb, var(--accent) 13%, ${t.bg})` : "#262F52");
  st.setProperty("--editor-line", `color-mix(in srgb, ${t.fg} ${light ? 14 : 12}%, ${t.bg})`);
  st.setProperty("--editor-scheme", light ? "light" : "dark");
  return id;
}
editorThemeStore.subscribe(() => void editorTheme());
void editorTheme();

/** Highlights lines in the editor theme and tags each with its real line number and whether it's in focus. */
export async function toHtml(lines: string[], path: string, start: number, focus: [number, number] | null): Promise<string> {
  const dark = await editorTheme();
  const hl = await highlighter();
  return hl.codeToHtml(lines.join("\n"), {
    lang: langOf(path),
    themes: { light: "github-light", dark },
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
