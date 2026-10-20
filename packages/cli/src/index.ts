#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connections, extract, findSymbols, type EdgeFact, type Facts } from "@docent/extract";
import { loadDocentEnv } from "@docent/llm";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";

// This package's package.json: one folder up from src/ in a checkout, and from dist/ once built.
const VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version?: string }).version ?? "dev";

const USAGE = `docent — guided tours of a codebase

  docent                         open the app for the current folder (or choose one, outside a project)
  docent <repo>                  open the app for a repo (reads it first if needed)
  docent --port <n>              use another port than 4477 (also DOCENT_PORT)
  docent --version               print the version
  docent extract <repo>          read the repo and save its facts (never writes to the repo)
  docent fn <repo> <name>        show a function's connections from the saved facts
  docent stats <repo>            summarize the saved facts
  docent doctor                  check how Docent reaches Claude (your subscription or an API key)
  docent discover <repo>         ask Claude to propose the feature map (you review it next)
  docent features <repo>         show the feature map
  docent approve <repo>          freeze the feature map as reviewed
  docent episode <repo> <id>     write the narrated episode for a verified feature
  docent voice <repo> <id>       speak every line of an episode ahead of time (cached)
  docent verify <repo> [id]      verify features not yet verified (or one, again) with checked evidence

Everything Docent writes lives in ~/.docent/. It never writes to the repo.`;

const short = (path: string) => path.split("/").slice(-2).join("/");
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const tag = (c: string) => (c === "confirmed" ? "\x1b[32m●\x1b[0m" : c === "inferred" ? "\x1b[33m●\x1b[0m" : "\x1b[90m●\x1b[0m");

function cacheFile(repo: string): string {
  const root = resolve(repo);
  const dir = join(homedir(), ".docent", "repos", `${basename(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "facts.json");
}

async function load(repo: string): Promise<Facts> {
  const file = cacheFile(repo);
  if (!existsSync(file)) return run(repo);
  return JSON.parse(readFileSync(file, "utf8")) as Facts;
}

async function run(repo: string): Promise<Facts> {
  const started = Date.now();
  const facts = await extract(repo, { onStage: (s) => process.stderr.write(dim(`  ${s}…\n`)) });
  const file = cacheFile(repo);
  writeFileSync(file, JSON.stringify(facts));
  printStats(facts);
  console.log(dim(`\n  ${((Date.now() - started) / 1000).toFixed(1)}s · saved ${file}`));
  return facts;
}

function printStats(f: Facts) {
  const count = <T>(xs: T[], key: (x: T) => string) => Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {}))
    .map(([k, n]) => `${n} ${k}`).join(", ");
  console.log(`\n${bold(f.repo.name)} ${dim(`${f.repo.head ?? "no commits"}${f.repo.dirty ? " · uncommitted changes" : ""}`)}`);
  console.log(`  stack        ${f.stack.join(", ") || "—"}`);
  console.log(`  files        ${count(f.files, (x) => x.kind)}`);
  console.log(`  symbols      ${count(f.symbols, (x) => x.kind)}`);
  console.log(`  links        ${count(f.edges, (x) => `${x.kind} (${x.confidence})`)}`);
  console.log(`  imports      ${f.imports.length} (${f.imports.filter((i) => i.external).length} from packages)`);
  console.log(`  tests        ${f.tests.length} cases`);
  console.log(`  entries      ${f.entries.filter((e) => e.kind !== "script").map((e) => `${e.file} ${dim(`(${e.kind})`)}`).join(", ") || "—"}`);
  console.log(`  history      ${f.commits.length} commits`);
  console.log(`  docs         ${f.docs.filter((d) => d.kind === "doc").length} docs, ${f.docs.filter((d) => d.kind === "agent").length} agent files · ${f.docs.reduce((n, d) => n + d.mentions.filter((m) => m.missing).length, 0)} mentions of paths that don't exist`);
  console.log(`  env          ${[...new Set(f.env.map((e) => e.name))].join(", ") || "—"}`);
  console.log(`  unreferenced ${f.unreferenced.length} source files`);
  for (const w of f.warnings.slice(0, 5)) console.log(`  ${dim("warning")}      ${w}`);
  if (f.warnings.length > 5) console.log(dim(`               …and ${f.warnings.length - 5} more warnings`));
}

function printFn(facts: Facts, name: string) {
  const matches = findSymbols(facts, name);
  if (!matches.length) {
    console.error(`No symbol named ${name}.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.log(`${matches.length} symbols match; showing each.\n`);
  }
  for (const symbol of matches) {
    const c = connections(facts, symbol);
    const loc = (file: string, line: number) => dim(`${short(file)}:${line}`);
    console.log(`${bold(symbol.name)} ${dim(symbol.kind)}  ${symbol.file}:${symbol.range.start}-${symbol.range.end}${symbol.exported ? "" : dim(" · not exported")}`);
    console.log(`\n  ${bold("Called by")}`);
    for (const e of c.callers.filter((x) => !x.from.includes("#test:"))) console.log(`    ${tag(e.confidence)} ${e.from.split("#")[1]}  ${loc(e.file, e.line)}${e.kind !== "calls" ? dim(` (${e.kind})`) : ""}`);
    if (!c.callers.some((x) => !x.from.includes("#test:"))) console.log(dim("    nothing outside tests calls it"));
    console.log(`\n  ${bold("Calls")}`);
    const groups = new Map<string, EdgeFact[]>();
    for (const e of c.callees) groups.set(`${e.kind}|${e.to}`, [...(groups.get(`${e.kind}|${e.to}`) ?? []), e]);
    for (const [, es] of groups) {
      const e = es[0]!;
      const [file, name] = e.to.split("#");
      const verb = e.kind === "constructs" ? dim("new ") : e.kind === "renders" ? dim("<") : "";
      const lines = es.map((x) => x.line).join(", ");
      console.log(`    ${tag(e.confidence)} ${verb}${name}  ${dim(`in ${short(file!)} · used on line${es.length > 1 ? "s" : ""} ${lines}`)}${e.via ? dim(` · ${e.via}`) : ""}`);
    }
    console.log(`\n  ${bold("Tests")}`);
    for (const t of c.tests) console.log(`    ${tag("confirmed")} ${t.test.name}  ${loc(t.test.file, t.test.range.start)}${t.hops ? dim(" · through a helper") : ""}`);
    if (!c.tests.length) console.log(dim("    no test reaches it"));
    console.log(`\n  ${bold("Docs that name it")}`);
    for (const m of c.mentions) console.log(`    ${m.doc}:${m.line}`);
    if (!c.mentions.length) console.log(dim("    none"));
    console.log(`\n  ${bold("History of its file")} ${dim(`(${c.history.length} commits)`)}`);
    for (const h of c.history.slice(0, 6)) console.log(`    ${h.sha} ${dim(h.date)} ${h.subject}`);
    if (c.cochange.length) console.log(`\n  ${bold("Usually changes with")}\n${c.cochange.slice(0, 5).map((x) => `    ${x.file} ${dim(`×${x.count}`)}`).join("\n")}`);
    console.log(dim(`\n  ${tag("confirmed")} resolved by the compiler   ${tag("inferred")} reasoned, not proven\n`));
  }
}

async function doctor() {
  const { pickProvider, providerStatuses, z } = await import("@docent/llm");
  console.log(`\n  ${bold("AI providers")}`);
  for (const p of providerStatuses()) {
    const state = p.id === "api"
      ? (p.signedIn ? "key set" : "no key")
      : !p.installed ? "not installed" : p.signedIn === false ? "not signed in" : `ready${p.detail ? ` · ${p.detail}` : ""}`;
    console.log(`    ${p.name.padEnd(18)} ${dim(state)}${p.version ? dim(`  ${p.version}`) : ""}`);
    if (p.id !== "api" && !p.installed) console.log(dim(`      install: ${p.install}   then: ${p.signIn}`));
    else if (p.id !== "api" && p.signedIn === false) console.log(dim(`      sign in: ${p.signIn}`));
  }
  const provider = pickProvider();
  console.log(`\n  ${bold("Using")}  ${provider.describe()}`);
  process.stdout.write(dim("  checking… "));
  const started = Date.now();
  const r = await provider.ask({ system: "Answer in the requested JSON.", prompt: "Reply with ok: true.", schema: z.object({ ok: z.boolean() }), effort: "low" });
  console.log(r.data.ok ? `\x1b[32mworks\x1b[0m ${dim(`(${r.model}, ${((Date.now() - started) / 1000).toFixed(1)}s)`)}` : "unexpected answer");
  console.log(dim("  Choose in Settings → AI, or with DOCENT_PROVIDER=claude-code|codex|api.\n"));
}

async function discover(repo: string) {
  const { discoverFeatures, saveFeatureMap } = await import("@docent/analyze");
  const { pickProvider } = await import("@docent/llm");
  const facts = await load(repo);
  const llm = pickProvider();
  console.log(dim(`  ${llm.describe()}`));
  process.stderr.write(dim("  reading the facts and proposing features (a minute or two)…\n"));
  const started = Date.now();
  const map = await discoverFeatures(llm, facts, resolve(repo));
  saveFeatureMap(resolve(repo), map);
  printFeatures(map);
  console.log(dim(`\n  ${((Date.now() - started) / 1000).toFixed(0)}s · proposed, not yet approved. Review it in the app, or run: docent approve ${repo}`));
}

function printFeatures(map: import("@docent/analyze").FeatureMap) {
  console.log(`\n${bold(`${map.features.length} features`)} ${dim(`(${map.state}${map.approvedAt ? ` ${map.approvedAt.slice(0, 10)}` : ""}, ${map.model})`)}`);
  for (const f of map.features) {
    console.log(`  ${bold(f.name)} ${dim(`${f.id} · ${f.kind} · ${f.files.length} files · ${f.confidence}`)}`);
    console.log(`    ${f.summary}`);
  }
  if (map.unassigned.length) console.log(dim(`\n  ${map.unassigned.length} files unassigned`));
  if (map.notes.length) console.log(dim(`  ${map.notes.length} fixes by the mechanical check (first: ${map.notes[0]})`));
}

async function episode(repo: string, id: string) {
  const { loadAnalysis, loadFeatureMap, saveEpisode, writeEpisode } = await import("@docent/analyze");
  const { pickProvider } = await import("@docent/llm");
  const root = resolve(repo);
  const feature = loadFeatureMap(root)?.features.find((f) => f.id === id);
  if (!feature) throw new Error(`No feature ${id}`);
  const analysis = loadAnalysis(root, id);
  if (!analysis) throw new Error(`Verify it first: docent verify ${repo} ${id}`);
  const llm = pickProvider();
  console.log(dim(`  ${llm.describe()} · writing the episode for ${feature.name}`));
  const started = Date.now();
  const e = await writeEpisode(llm, await load(repo), root, feature, analysis);
  saveEpisode(root, e);
  const claims = [...e.scenes.flatMap((s) => s.steps.flatMap((st) => [st.claim, ...(st.predict ? [st.predict.reveal] : [])])), ...e.selfCheck.map((q) => q.answer)];
  const steps = e.scenes.reduce((n, s) => n + s.steps.length, 0);
  console.log(`  ${bold(e.title)} ${dim(`· ${e.scenes.length} scenes, ${steps} steps, ${e.cast.length} boxes · ${claims.filter((c) => c.label === "confirmed").length} of ${claims.length} claims confirmed, ${claims.filter((c) => c.claimedLabel).length} taken back · ${((Date.now() - started) / 1000).toFixed(0)}s`)}`);
  if (e.notes.length) console.log(dim(`  clean-up: ${e.notes.join("; ")}`));
}

/** Speaks every line of an episode ahead of time, so playback never waits for a clip. Cached lines are skipped. */
async function voice(repo: string, id: string) {
  const { loadEpisode, narrationLine } = await import("@docent/analyze");
  const { pickVoice, speak } = await import("@docent/voice");
  const e = loadEpisode(resolve(repo), id);
  if (!e) throw new Error(`No episode for ${id} yet. Run: docent episode ${repo} ${id}`);
  const v = pickVoice();
  if ("reason" in v) throw new Error(v.reason);
  const total = e.scenes.reduce((n, s) => n + s.steps.length, 0);
  console.log(dim(`  ${v.adapter.id} · ${total} lines for ${e.title}`));
  const started = Date.now();
  let seconds = 0;
  for (let at = 0; at < total; at++) {
    const line = narrationLine(e, at)!;
    const clip = await speak(v.adapter, v.voice, line.text, { speed: v.speed, ...(v.expressive ? { tone: line.tone } : {}) });
    seconds += clip.durationMs / 1000;
    process.stdout.write(`\r  ${at + 1}/${total} · ${line.tone.padEnd(9)} · ${(clip.durationMs / 1000).toFixed(1)}s   `);
  }
  console.log(`\n  ${bold("Ready")} ${dim(`· ${Math.round(seconds)}s of narration · ${((Date.now() - started) / 1000).toFixed(0)}s to build`)}`);
}

async function verify(repo: string, only?: string) {
  const { filesHash, loadAnalysis, loadFeatureMap, saveAnalysis, verifyAll } = await import("@docent/analyze");
  const { pickProvider } = await import("@docent/llm");
  const root = resolve(repo);
  const map = loadFeatureMap(root);
  if (!map) throw new Error("No feature map yet. Run: docent discover <repo>");
  const facts = await load(repo);
  if (only && !map.features.some((f) => f.id === only)) throw new Error(`No feature ${only}`);
  // Without an id, skip features already verified against this code and through the second reader.
  const done = (f: (typeof map.features)[number]) => {
    const a = loadAnalysis(root, f.id);
    return !!a && a.filesHash === filesHash(facts, f.files) && a.claims.some((c) => c.review);
  };
  const skipped = only ? [] : map.features.filter(done);
  const features = map.features.filter((f) => (only ? f.id === only : !done(f)));
  if (skipped.length) console.log(dim(`  already verified and unchanged: ${skipped.map((f) => f.id).join(", ")}`));
  if (!features.length) return console.log("  Every feature is verified and up to date.");
  const llm = pickProvider();
  console.log(dim(`  ${llm.describe()} · verifying ${features.length} feature${features.length > 1 ? "s" : ""}, 3 at a time`));
  await verifyAll(llm, facts, root, features, {
    onDone: (id, r) => {
      if (r instanceof Error) return console.log(`  \x1b[31m✗\x1b[0m ${id}: ${r.message}`);
      saveAnalysis(root, r);
      const confirmed = r.claims.filter((c) => c.label === "confirmed").length;
      const demoted = r.claims.filter((c) => c.claimedLabel).length;
      console.log(`  \x1b[32m✓\x1b[0m ${bold(id)} ${dim(`${r.status} · ${r.claims.length} claims (${confirmed} confirmed, ${demoted} taken back by the check or second reader) · ${r.issues.length} issues`)}`);
    },
  });
}

async function openApp(repo?: string) {
  const { startServer } = await import("@docent/server");
  const log = (s: string) => process.stderr.write(dim(`  ${s}…\n`));
  // 4477 already taken (often another Docent): take any free port rather than fail.
  const { url } = await startServer({ repo, port, log }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE" || portAsked) throw error;
    return startServer({ repo, port: 0, log });
  });
  const showing = repo ? `is showing ${basename(resolve(repo))}` : "is ready; choose a codebase";
  console.log(`\n  ${bold("Docent")} ${showing} at ${url}\n  ${dim("Ctrl+C to stop.")}`);
  // Straight to the codebase's page; without one, the welcome page asks which to open.
  const page = repo ? `${url}/#/repo/${encodeURIComponent(basename(resolve(repo)))}` : url;
  // `start` is built into cmd, and its first quoted argument is a window title.
  const [opener, ...args] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  if (!process.env.DOCENT_NO_OPEN) execFile(opener!, [...args, page], () => {});
}

const isDir = (p: string | undefined) => {
  try {
    return !!p && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The current folder, when it looks like a project; otherwise the app asks which codebase to open. */
const here = () => [".git", "package.json", "pyproject.toml", "setup.py", "requirements.txt", "go.mod"].some((f) => existsSync(join(process.cwd(), f))) ? process.cwd() : undefined;

// Keys (CARTESIA_API_KEY, ANTHROPIC_API_KEY…) from Docent's own .env, if there is one. Never the analyzed repo's.
loadDocentEnv();

const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const portAsked = portAt >= 0 ? args.splice(portAt, 2)[1] : process.env.DOCENT_PORT;
const port = Number(portAsked) || 4477;
const [cmd, repo, name] = args;
try {
  if (cmd === "--version" || cmd === "-v") console.log(VERSION);
  else if (cmd === "--help" || cmd === "-h" || cmd === "help") console.log(USAGE);
  else if (!cmd) await openApp(here());
  else if (isDir(cmd) && !repo) await openApp(cmd);
  else if (cmd === "open") await openApp(repo);
  else if (cmd === "doctor") await doctor();
  else if (cmd === "discover" && repo) await discover(repo);
  else if (cmd === "features" && repo) {
    const { loadFeatureMap } = await import("@docent/analyze");
    const map = loadFeatureMap(resolve(repo));
    if (!map) throw new Error("No feature map yet. Run: docent discover <repo>");
    printFeatures(map);
  } else if (cmd === "approve" && repo) {
    const { loadFeatureMap, saveFeatureMap } = await import("@docent/analyze");
    const map = loadFeatureMap(resolve(repo));
    if (!map) throw new Error("No feature map yet. Run: docent discover <repo>");
    saveFeatureMap(resolve(repo), { ...map, state: "approved", approvedAt: new Date().toISOString() });
    console.log("  Feature map approved and frozen.");
  } else if (cmd === "verify" && repo) await verify(repo, name);
  else if (cmd === "episode" && repo && name) await episode(repo, name);
  else if (cmd === "voice" && repo && name) await voice(repo, name);
  else if (cmd === "extract" && repo) await run(repo);
  else if (cmd === "stats" && repo) printStats(await load(repo));
  else if (cmd === "fn" && repo && name) printFn(await load(repo), name);
  else console.log(USAGE);
} catch (error) {
  console.error(`docent: ${(error as Error).message}`);
  process.exit(1);
}
