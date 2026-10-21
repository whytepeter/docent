import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { repoCacheDir } from "./cache.ts";
import { pythonGoStackAndEntries } from "./manifests.ts";
import { git } from "./repo.ts";
import type { CommitFact, DocFact, DocMention, EntryFact, FileFact, SymbolFact } from "./types.ts";

const MAX_COMMITS = 3000;
const COCHANGE_MAX_FILES = 40;
/** Agent state and lockfiles change with everything; they say nothing about how code is coupled. */
const BOOKKEEPING = /^(\.wolf|\.claude|\.cursor|\.codex|\.agents)\/|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum)$/; // sweeping commits (formatting, renames) say nothing about coupling

export function readHistory(root: string, known: Set<string>): { commits: CommitFact[]; cochange: Record<string, { file: string; count: number }[]> } {
  let raw = "";
  try {
    raw = git(root, ["log", "--no-merges", `-n${MAX_COMMITS}`, "--date=short", "--name-only", "--format=%x1e%h%x1f%ad%x1f%s%x1f%b%x1f"]);
  } catch {
    return { commits: [], cochange: {} };
  }
  const commits: CommitFact[] = [];
  const coding: string[][] = [];
  for (const chunk of raw.split("\x1e").slice(1)) {
    const [sha = "", date = "", subject = "", body = "", rest = ""] = chunk.split("\x1f");
    const files = rest.split("\n").map((f) => f.trim()).filter((f) => f && known.has(f));
    const code = files.filter((f) => !BOOKKEEPING.test(f));
    commits.push({ sha, date, subject, body: body.trim().slice(0, 4000), files });
    coding.push(code);
  }
  const pairs = new Map<string, Map<string, number>>();
  for (const files of coding) {
    if (files.length < 2 || files.length > COCHANGE_MAX_FILES) continue;
    for (const a of files) {
      const row = pairs.get(a) ?? new Map<string, number>();
      for (const b of files) if (a !== b) row.set(b, (row.get(b) ?? 0) + 1);
      pairs.set(a, row);
    }
  }
  const cochange: Record<string, { file: string; count: number }[]> = {};
  for (const [file, row] of pairs) {
    cochange[file] = [...row].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([f, count]) => ({ file: f, count }));
  }
  return { commits, cochange };
}

/**
 * Finds the commit that removed a name's declaration: the last commit that changed how often it
 * appears (`git log -S`), only if that commit deleted a line declaring it. A name the code never
 * declared (a browser API, an EXIF tag, a JSON field) returns null, so the doc isn't flagged.
 */
type Removal = { sha: string; subject: string } | null;

/**
 * Which commit removed a name a doc still mentions. Each answer is a search of the whole history (seconds on a
 * repo with many such names), and it depends only on the commits, so answers are kept per HEAD in Docent's own
 * folder and reused until a new commit lands.
 */
function removalOf(root: string) {
  let head = "";
  try {
    head = git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    /* no history */
  }
  const file = join(repoCacheDir(root), "removals.json");
  let cache = new Map<string, Removal>();
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { head: string; names: Record<string, Removal> };
    if (head && saved.head === head) cache = new Map(Object.entries(saved.names));
  } catch {
    /* none yet */
  }
  let added = false;
  const lookup = (name: string) => {
    if (!cache.has(name)) {
      let found: Removal = null;
      try {
        const [sha, subject = ""] = git(root, ["log", "-S", name, "-1", "--format=%h%x09%s"]).trim().split("\t");
        if (sha) {
          const esc = name.replace(/[$]/g, "\\$");
          const declared = new RegExp(`^-(?!--).*\\b(class|function|interface|type|enum|const|let|var|def|func(?:\\s+\\([^)]*\\))?)\\s+${esc}\\b`, "m");
          if (declared.test(git(root, ["show", sha, "--format=", "-U0"]))) found = { sha, subject };
        }
      } catch {
        /* no history */
      }
      cache.set(name, found);
      added = true;
    }
    return cache.get(name)!;
  };
  const save = () => {
    if (head && added) writeFileSync(file, JSON.stringify({ head, names: Object.fromEntries(cache) }));
  };
  return { lookup, save };
}

export function readDocs(root: string, files: FileFact[], symbols: SymbolFact[]): DocFact[] {
  const paths = new Set(files.map((f) => f.path));
  const removals = removalOf(root);
  const removal = removals.lookup;
  const byName = new Map<string, string[]>();
  for (const s of symbols) byName.set(s.name, [...(byName.get(s.name) ?? []), s.id]);

  // Every word in every code file, comments included, so a name only counts as gone when nothing mentions it.
  const codeWords = new Set<string>();
  for (const f of files.filter((f) => f.lang)) for (const w of readFileSync(join(root, f.path), "utf8").matchAll(/[A-Za-z_$][\w$]*/g)) codeWords.add(w[0]);
  // Only names shaped like code (PascalCase or camelCase with a hump) are checked; plain words in backticks are not.
  const codeName = /^(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)$/;

  const resolveMention = (text: string, docDir: string): Pick<DocMention, "target" | "missing" | "missingKind" | "removedIn"> => {
    const clean = text.replace(/\(\)$/, "").replace(/^\.?\//, "").replace(/[:#]\d+(-\d+)?$/, "");
    if (paths.has(clean)) return { target: clean };
    const local = posix.normalize(posix.join(docDir, clean));
    if (paths.has(local)) return { target: local };
    const suffix = [...paths].filter((p) => p.endsWith(`/${clean}`));
    if (suffix.length === 1) return { target: suffix[0]! };
    const ids = byName.get(clean);
    if (ids?.length === 1) return { target: ids[0]! };
    const pathLike = /^[\w.@~-]+(\/[\w.@[\]()-]+)+\.\w{1,5}$/.test(clean);
    if (pathLike) return { target: null, missing: true, missingKind: "path" };
    if (clean.length >= 6 && codeName.test(clean) && !codeWords.has(clean)) {
      const removedIn = removal(clean);
      if (removedIn) return { target: null, missing: true, missingKind: "name", removedIn };
    }
    return { target: null };
  };

  const docs: DocFact[] = [];
  for (const file of files.filter((f) => f.kind === "doc" || (f.kind === "agent" && /\.(md|mdc|txt)$/.test(f.path)))) {
    const text = readFileSync(join(root, file.path), "utf8");
    const headings: DocFact["headings"] = [];
    const mentions: DocFact["mentions"] = [];
    let fence = false;
    text.split("\n").forEach((line, i) => {
      if (/^\s*```/.test(line)) fence = !fence;
      if (fence) return;
      const h = /^(#{1,4})\s+(.+)/.exec(line);
      if (h) headings.push({ text: h[2]!.trim(), line: i + 1 });
      for (const m of line.matchAll(/`([^`\s][^`]{1,120})`/g)) {
        const resolved = resolveMention(m[1]!, posix.dirname(file.path));
        if (resolved.target || resolved.missing) mentions.push({ text: m[1]!, line: i + 1, ...resolved });
      }
    });
    docs.push({ path: file.path, kind: file.kind === "agent" ? "agent" : "doc", headings, mentions });
  }
  removals.save();
  return docs;
}

export function scanSource(root: string, files: FileFact[]) {
  const env: { name: string; file: string; line: number }[] = [];
  const markers: { kind: string; file: string; line: number; text: string }[] = [];
  for (const file of files.filter((f) => f.kind === "source" || f.kind === "test")) {
    readFileSync(join(root, file.path), "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/(?:import\.meta\.env|process\.env)(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g)) {
        env.push({ name: (m[1] ?? m[2])!, file: file.path, line: i + 1 });
      }
      // Python `os.environ["X"]`, `os.environ.get("X")`, `os.getenv("X")`; Go `os.Getenv("X")`, `os.LookupEnv("X")`.
      for (const m of line.matchAll(/\bos\.(?:environ(?:\.get\(|\[)|getenv\(|Getenv\(|LookupEnv\()\s*["']([A-Z][A-Z0-9_]*)["']/g)) {
        env.push({ name: m[1]!, file: file.path, line: i + 1 });
      }
      const marker = /(?:\/\/|\/\*|\*|#|<!--)\s*(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)/.exec(line);
      if (marker) markers.push({ kind: marker[1]!, file: file.path, line: i + 1, text: marker[2]!.trim().slice(0, 160) });
    });
  }
  return { env, markers };
}

const STACK_DEPS: Record<string, string> = {
  react: "React", vue: "Vue", nuxt: "Nuxt", next: "Next.js", svelte: "Svelte", "@sveltejs/kit": "SvelteKit",
  vite: "Vite", express: "Express", hono: "Hono", fastify: "Fastify", "@nestjs/core": "NestJS", "@angular/core": "Angular",
  vitest: "Vitest", jest: "Jest", "@playwright/test": "Playwright", zustand: "Zustand", pinia: "Pinia",
  tailwindcss: "Tailwind", "@tailwindcss/vite": "Tailwind", prisma: "Prisma", "drizzle-orm": "Drizzle",
  graphql: "GraphQL", "@apollo/client": "Apollo", i18next: "i18next", "react-router": "React Router", "react-router-dom": "React Router",
};

export function readStackAndEntries(root: string, files: FileFact[]): { stack: string[]; entries: EntryFact[] } {
  const entries: EntryFact[] = [];
  const stack = new Set<string>();
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string> | string | undefined>;
    const deps = { ...(pkg.dependencies as Record<string, string>), ...(pkg.devDependencies as Record<string, string>) };
    for (const dep of Object.keys(deps)) if (STACK_DEPS[dep]) stack.add(STACK_DEPS[dep]!);
    for (const [name, cmd] of Object.entries((pkg.scripts as Record<string, string>) ?? {})) {
      entries.push({ kind: "script", file: "package.json", detail: `${name}: ${cmd}`, confidence: "confirmed" });
    }
    if (typeof pkg.main === "string") entries.push({ kind: "main", file: pkg.main, detail: "package.json main", confidence: "confirmed" });
    const bin = pkg.bin;
    if (typeof bin === "string") entries.push({ kind: "bin", file: bin, detail: "package.json bin", confidence: "confirmed" });
    else if (bin) for (const [name, file] of Object.entries(bin)) entries.push({ kind: "bin", file, detail: `command ${name}`, confidence: "confirmed" });
  }
  for (const file of files.filter((f) => f.path.endsWith(".html"))) {
    const html = readFileSync(join(root, file.path), "utf8");
    for (const m of html.matchAll(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/g)) {
      entries.push({ kind: "browser-entry", file: m[1]!.replace(/^\//, ""), detail: `module script in ${file.path}`, confidence: "confirmed" });
    }
  }
  // File-system routing conventions. Real only if the framework is present, so label them inferred.
  const routed = [
    { re: /^(src\/)?pages\/.+\.(vue|[jt]sx?)$/, kind: "page (file route)", when: ["Nuxt", "Next.js"] },
    { re: /^(src\/)?app\/.*page\.[jt]sx?$/, kind: "page (app router)", when: ["Next.js"] },
    { re: /^(app\/)?pages\/.+\.vue$/, kind: "page (file route)", when: ["Nuxt"] },
    { re: /^server\/(api|routes)\/.+\.[jt]s$/, kind: "server route", when: ["Nuxt"] },
    { re: /^(src\/)?routes\/.+\+(page|server)\.[jt]s|svelte$/, kind: "route", when: ["SvelteKit"] },
  ];
  for (const file of files) {
    for (const rule of routed) {
      if (rule.re.test(file.path) && rule.when.some((s) => stack.has(s))) {
        entries.push({ kind: rule.kind, file: file.path, detail: `by ${rule.when.join("/")} file convention`, confidence: "inferred" });
      }
    }
  }
  const other = pythonGoStackAndEntries(root, files);
  for (const s of other.stack) stack.add(s);
  entries.push(...other.entries);
  return { stack: [...stack].sort(), entries };
}
