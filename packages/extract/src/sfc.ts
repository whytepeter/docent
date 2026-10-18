/**
 * Vue and Svelte single-file components, made readable to the TypeScript compiler.
 *
 * A component's `<script>` blocks are its code. `scriptView` keeps them where they are and blanks everything
 * else (template, style, the script tags themselves) to spaces, keeping every newline, so a line in the view
 * is the same line in the real file. The view is given to the compiler as `Foo.vue.ts`, which is also where
 * TypeScript looks when something imports `./Foo.vue`, so imports between components resolve on their own.
 *
 * The template isn't TypeScript, so `templateRefs` reads it separately: the tags it renders and the names its
 * expressions use (handlers, bindings, interpolations), each with its line.
 */

export type SfcKind = "vue" | "svelte";

export const sfcKind = (path: string): SfcKind | null => (path.endsWith(".vue") ? "vue" : path.endsWith(".svelte") ? "svelte" : null);

/** The compiler's name for a component's script view, and back. */
export const viewPath = (path: string) => `${path}.ts`;
export const isViewPath = (path: string) => /\.(vue|svelte)\.ts$/.test(path);
export const realPath = (path: string) => (isViewPath(path) ? path.slice(0, -3) : path);

interface Block {
  /** Where the block's content starts and ends in the file (offsets). */
  start: number;
  end: number;
  attrs: string;
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");

function blocks(text: string, tag: "script" | "style"): (Block & { open: number; close: number })[] {
  const out: (Block & { open: number; close: number })[] = [];
  const re = new RegExp(`<${tag}(\\s[^>]*)?>`, "gi");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[0].length;
    const close = text.toLowerCase().indexOf(`</${tag}>`, start);
    if (close < 0) break;
    out.push({ open: m.index, start, end: close, close: close + tag.length + 3, attrs: m[1] ?? "" });
    re.lastIndex = close;
  }
  return out;
}

/** The file with only its script code left in place. */
export function scriptView(text: string): string {
  const scripts = blocks(text, "script").filter((b) => !/\btype=["'](?!module|text\/javascript|application\/javascript)/i.test(b.attrs));
  let out = "";
  let at = 0;
  for (const b of scripts) {
    out += blank(text.slice(at, b.start)) + text.slice(b.start, b.end);
    at = b.end;
  }
  return out + blank(text.slice(at));
}

export interface TemplateRef {
  name: string;
  line: number;
}

/** What a component's template renders (tags) and uses (names in its expressions). */
export function templateRefs(kind: SfcKind, text: string): { tags: TemplateRef[]; names: TemplateRef[] } {
  // The template is everything outside script and style; for Vue, only an HTML `<template>` counts.
  let markup = text;
  for (const b of [...blocks(text, "script"), ...blocks(text, "style")]) {
    markup = markup.slice(0, b.open) + blank(markup.slice(b.open, b.close)) + markup.slice(b.close);
  }
  if (kind === "vue") {
    const open = /<template(\s[^>]*)?>/i.exec(markup);
    const close = markup.toLowerCase().lastIndexOf("</template>");
    if (!open || close < 0 || /\blang=["'](?!html)/i.test(open[1] ?? "")) return { tags: [], names: [] };
    markup = blank(markup.slice(0, open.index + open[0].length)) + markup.slice(open.index + open[0].length, close) + blank(markup.slice(close));
  }
  // Comments say nothing about what runs.
  markup = markup.replace(/<!--[\s\S]*?-->/g, blank);

  const lineAt = lineIndex(text);
  const tags: TemplateRef[] = [];
  for (const m of markup.matchAll(/<([A-Za-z][\w.:-]*)/g)) tags.push({ name: m[1]!, line: lineAt(m.index!) });

  const names: TemplateRef[] = [];
  const exprs: { at: number; code: string }[] = [];
  if (kind === "vue") {
    // {{ expr }}, and the value of @x, v-on:x, :x, v-bind:x, v-if, v-for, v-model…
    for (const m of markup.matchAll(/\{\{([\s\S]*?)\}\}/g)) exprs.push({ at: m.index! + 2, code: m[1]! });
    for (const m of markup.matchAll(/(?:^|\s)(?:@|:|v-[\w-]+(?::[\w.-]*)?)[\w.:[\]-]*\s*=\s*(["'])([\s\S]*?)\1/g)) {
      exprs.push({ at: m.index! + m[0].length - m[2]!.length - 1, code: m[2]! });
    }
  } else {
    // {expr}, {#if expr}, on:click={handler}, onclick={handler}, bind:value={x}
    for (const m of markup.matchAll(/\{([#:/@]?)([^{}]*)\}/g)) {
      if (m[1] === "/") continue;
      exprs.push({ at: m.index! + 1 + m[1]!.length, code: m[2]!.replace(/^(if|each|await|key|html|const|debug|render|snippet|else if)\b/, (k) => " ".repeat(k.length)) });
    }
  }
  for (const e of exprs) {
    const code = e.code.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, blank); // names inside strings aren't names
    for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)) names.push({ name: m[1]!, line: lineAt(e.at + m.index!) });
  }
  return { tags, names };
}

function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** `user-card` → `UserCard`, so a kebab-case tag finds its PascalCase import. */
export const pascal = (tag: string) => tag.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

/** A component's name from its file: `src/components/UserCard.vue` → `UserCard`; SvelteKit's `+page.svelte` → `Page`. */
export function componentName(path: string): string {
  const base = path.split("/").pop()!.replace(/\.(vue|svelte)$/, "");
  if (base.startsWith("+")) return pascal(base.slice(1));
  if (base.toLowerCase() === "index") return pascal(path.split("/").slice(-2, -1)[0] ?? "Index");
  return pascal(base);
}

/**
 * The names Nuxt (and unplugin-vue-components with directory prefixes) give a component it auto-imports:
 * `components/layout/sidebar/Index.vue` → `LayoutSidebar`; `components/base/BaseButton.vue` → `BaseButton`
 * (a folder already in the file's name isn't repeated).
 */
export function autoImportNames(path: string): string[] {
  const parts = path.replace(/\.(vue|svelte)$/, "").split("/");
  const at = parts.lastIndexOf("components");
  const names = new Set([componentName(path)]);
  if (at >= 0) {
    // Nuxt's rule: the folders' words, then the file's words, dropping the words where the folders' end
    // repeats the file's start (`base/radio-group/RadioGroupItem` → Base Radio Group + Item).
    const words = (seg: string) => pascal(seg).split(/(?=[A-Z])/).filter(Boolean);
    let file = words(parts[parts.length - 1]!);
    const dirs = parts.slice(at + 1, -1).flatMap(words);
    if (file.length === 1 && file[0]!.toLowerCase() === "index") file = [];
    let overlap = 0;
    for (let n = Math.min(dirs.length, file.length); n > 0; n--) {
      if (dirs.slice(-n).join("").toLowerCase() === file.slice(0, n).join("").toLowerCase()) { overlap = n; break; }
    }
    const name = [...dirs, ...file.slice(overlap)].join("");
    if (name) names.add(name);
  }
  return [...names];
}
