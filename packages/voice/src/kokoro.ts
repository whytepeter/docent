import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import type { Clip, SynthOptions, Tone, VoiceAdapter, VoiceInfo } from "./index.ts";
import { estimateWords, VoiceError, wav } from "./index.ts";

/**
 * Kokoro 82M (Apache-2.0), run on this computer with onnxruntime. Nothing leaves the machine once the
 * weights are downloaded. The "timestamped" export also returns how long each phoneme lasts, which gives
 * real word timings. Phonemes come from espeak-ng (compiled to wasm), as in kokoro-js.
 */

const REPO = "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped";
/** Pinned, so a download today and next year fetch the same files. */
const REVISION = "dd4401a9add81ac692d20e240d22ec9dda82cc29";
const MODEL_FILE = "onnx/model_quantized.onnx";
const SAMPLE_RATE = 24000;
/** The model's context is 512 tokens, two of which are the pads at either end. */
const MAX_TOKENS = 510;

/** The English voices, with the quality grades their author gives them. */
const VOICES: Record<string, { name: string; accent: "American" | "British"; gender: "Female" | "Male"; grade: string }> = {
  af_heart: { name: "Heart", accent: "American", gender: "Female", grade: "A" },
  af_bella: { name: "Bella", accent: "American", gender: "Female", grade: "A-" },
  af_nicole: { name: "Nicole", accent: "American", gender: "Female", grade: "B-" },
  af_aoede: { name: "Aoede", accent: "American", gender: "Female", grade: "C+" },
  af_kore: { name: "Kore", accent: "American", gender: "Female", grade: "C+" },
  af_sarah: { name: "Sarah", accent: "American", gender: "Female", grade: "C+" },
  af_alloy: { name: "Alloy", accent: "American", gender: "Female", grade: "C" },
  af_nova: { name: "Nova", accent: "American", gender: "Female", grade: "C" },
  af_sky: { name: "Sky", accent: "American", gender: "Female", grade: "C-" },
  af_jessica: { name: "Jessica", accent: "American", gender: "Female", grade: "D" },
  af_river: { name: "River", accent: "American", gender: "Female", grade: "D" },
  am_fenrir: { name: "Fenrir", accent: "American", gender: "Male", grade: "C+" },
  am_michael: { name: "Michael", accent: "American", gender: "Male", grade: "C+" },
  am_puck: { name: "Puck", accent: "American", gender: "Male", grade: "C+" },
  am_echo: { name: "Echo", accent: "American", gender: "Male", grade: "D" },
  am_eric: { name: "Eric", accent: "American", gender: "Male", grade: "D" },
  am_liam: { name: "Liam", accent: "American", gender: "Male", grade: "D" },
  am_onyx: { name: "Onyx", accent: "American", gender: "Male", grade: "D" },
  am_santa: { name: "Santa", accent: "American", gender: "Male", grade: "D-" },
  am_adam: { name: "Adam", accent: "American", gender: "Male", grade: "F+" },
  bf_emma: { name: "Emma", accent: "British", gender: "Female", grade: "B-" },
  bf_isabella: { name: "Isabella", accent: "British", gender: "Female", grade: "C" },
  bf_alice: { name: "Alice", accent: "British", gender: "Female", grade: "D" },
  bf_lily: { name: "Lily", accent: "British", gender: "Female", grade: "D" },
  bm_fable: { name: "Fable", accent: "British", gender: "Male", grade: "C" },
  bm_george: { name: "George", accent: "British", gender: "Male", grade: "C" },
  bm_daniel: { name: "Daniel", accent: "British", gender: "Male", grade: "D" },
  bm_lewis: { name: "Lewis", accent: "British", gender: "Male", grade: "D+" },
};
export const KOKORO_DEFAULT_VOICE = "af_heart";

const FILES = ["tokenizer.json", MODEL_FILE, ...Object.keys(VOICES).map((v) => `voices/${v}.bin`)];
/** What the download weighs: the 8-bit model, the vocabulary and 28 voices of 512 KiB each. */
export const KOKORO_SIZE = 92_361_055 + 3_500 + Object.keys(VOICES).length * 524_288;

/** Kokoro has no emotion control, so tone only nudges the pace (as Cartesia's "concerned" does). */
const KOKORO_PACE: Record<Tone, number> = { calm: 1, warm: 1, curious: 1, concerned: 0.94, emphatic: 0.97 };

// ---------------------------------------------------------------- the download

export const modelDir = () => join(homedir(), ".docent", "models", "kokoro");
const manifest = () => join(modelDir(), "manifest.json");

/**
 * The packages that run the model. onnxruntime-node weighs about 290 MB, so it isn't part of Docent's own
 * install: a checkout has it from the workspace, and an npm install gets it here, with the weights.
 */
const RUNTIME = { "onnxruntime-node": ortVersion(), phonemizer: "1.2.1" };
const runtimeDir = () => join(modelDir(), "runtime");

/**
 * onnxruntime-node ships native builds for these platforms only. Intel Macs were dropped after 1.23.2, so
 * they get that version (Node built for Intel and run under Rosetta counts as an Intel Mac).
 */
const ORT_BUILDS = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]);
function platform(): string {
  return `${process.platform}-${process.arch}`;
}
function ortVersion(): string {
  return platform() === "darwin-x64" ? "1.23.2" : "1.30.0";
}
/** Whether the local voice can run here at all. */
export const kokoroSupported = () => ORT_BUILDS.has(platform()) && !musl();
/** onnxruntime's Linux builds need glibc; Alpine and other musl systems can't load them. */
function musl(): boolean {
  if (process.platform !== "linux") return false;
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return !header?.glibcVersionRuntime;
}
const PLATFORM_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
export const platformLabel = () => `${PLATFORM_NAMES[process.platform] ?? process.platform}${musl() ? " (musl)" : ""} on ${process.arch === "x64" ? "Intel/AMD (x64)" : process.arch}`;

/** An onnxruntime-node install only counts if it has the native build for this computer. */
function hasBinding(resolved: string): boolean {
  const at = resolved.lastIndexOf("onnxruntime-node");
  if (at < 0) return true;
  const root = resolved.slice(0, at + "onnxruntime-node".length);
  return existsSync(join(root, "bin", "napi-v6", process.platform, process.arch, "onnxruntime_binding.node"));
}

/**
 * Where a runtime package resolves from: Docent's own dependencies first, then the downloaded runtime.
 * The runtime folder is asked only once the package is in it, because Node remembers a failed lookup
 * and would keep failing after the install.
 */
function resolveRuntime(name: keyof typeof RUNTIME): string | null {
  const downloaded = existsSync(join(runtimeDir(), "node_modules", name, "package.json"));
  for (const from of [import.meta.url, ...(downloaded ? [pathToFileURL(join(runtimeDir(), "package.json")).href] : [])]) {
    try {
      const at = createRequire(from).resolve(name);
      // A checkout's own copy, or a runtime installed before this computer needed another version, may lack
      // the native build: then it doesn't count, and the download installs the right one.
      if (name === "onnxruntime-node" && !hasBinding(at)) continue;
      return at;
    } catch {
      /* not there: try the next place */
    }
  }
  return null;
}

const runtimeReady = () => Object.keys(RUNTIME).every((n) => resolveRuntime(n as keyof typeof RUNTIME));

const missingRuntime = () =>
  new VoiceError(kokoroSupported() ? "The local voice isn't downloaded yet. Download it in Settings → Narrator." : `The local voice can't run on ${platformLabel()}. Choose a cloud voice in Settings → Narrator.`);

async function importRuntime<T>(name: keyof typeof RUNTIME): Promise<T> {
  const at = resolveRuntime(name);
  if (!at) throw missingRuntime();
  return (await import(pathToFileURL(at).href)) as T;
}

/** Installs the runtime packages into Docent's model folder with npm (never into a repo). */
async function installRuntime(signal: AbortSignal): Promise<void> {
  mkdirSync(runtimeDir(), { recursive: true });
  // An install without this computer's native build (another version, or files gone) looks complete to npm:
  // remove it so npm puts the right one back.
  const ort = join(runtimeDir(), "node_modules", "onnxruntime-node");
  if (existsSync(ort) && !hasBinding(join(ort, "dist", "index.js"))) rmSync(ort, { recursive: true, force: true });
  writeFileSync(join(runtimeDir(), "package.json"), JSON.stringify({ private: true, dependencies: RUNTIME }));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await promisify(execFile)(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: runtimeDir(), signal, shell: process.platform === "win32" });
}

export interface ModelStatus {
  state: "absent" | "downloading" | "ready" | "error" | "unsupported";
  /** Bytes on disk so far, while downloading. */
  received: number;
  size: number;
  error?: string;
}

let download: { received: number; size: number; abort: AbortController; error?: string } | null = null;

/** Ready once every file is in and the manifest written last says this revision. */
export function kokoroReady(): boolean {
  try {
    return (JSON.parse(readFileSync(manifest(), "utf8")) as { revision?: string }).revision === REVISION && runtimeReady();
  } catch {
    return false;
  }
}

export function kokoroStatus(): ModelStatus {
  if (!kokoroSupported()) return { state: "unsupported", received: 0, size: KOKORO_SIZE, error: `The local voice's runtime (onnxruntime) has no build for ${platformLabel()}. Use a cloud voice instead.` };
  if (download && !download.error) return { state: "downloading", received: download.received, size: download.size };
  if (kokoroReady()) return { state: "ready", received: KOKORO_SIZE, size: KOKORO_SIZE };
  if (!download) return { state: "absent", received: 0, size: KOKORO_SIZE };
  return { state: "error", received: download.received, size: download.size, error: download.error };
}

/** Starts the download in the background (once); poll `kokoroStatus` for progress. */
export function downloadKokoro(): ModelStatus {
  if (!kokoroSupported() || kokoroReady() || (download && !download.error)) return kokoroStatus();
  const job = { received: 0, size: KOKORO_SIZE, abort: new AbortController() } as NonNullable<typeof download>;
  download = job;
  void (async () => {
    try {
      if (!runtimeReady()) {
        await installRuntime(job.abort.signal);
        if (!runtimeReady()) throw new VoiceError(`onnxruntime installed, but without a build for ${platformLabel()}`);
      }
      for (const file of FILES) {
        const to = join(modelDir(), file);
        if (existsSync(to)) continue;
        mkdirSync(join(to, ".."), { recursive: true });
        const res = await fetch(`https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`, { signal: job.abort.signal });
        if (!res.ok || !res.body) throw new VoiceError(`Hugging Face answered ${res.status} for ${file}`);
        const counted = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
        counted.on("data", (chunk: Buffer) => (job.received += chunk.length));
        // Written beside the target and renamed, so a half-finished file never counts as downloaded.
        await pipeline(counted, createWriteStream(`${to}.part`), { signal: job.abort.signal });
        renameSync(`${to}.part`, to);
      }
      writeFileSync(manifest(), JSON.stringify({ repo: REPO, revision: REVISION, model: MODEL_FILE }));
      if (download === job) download = null;
    } catch (e) {
      if (download === job) job.error = job.abort.signal.aborted ? "Download stopped" : `Download failed: ${(e as Error).message}`;
    }
  })();
  return kokoroStatus();
}

/** Stops a download in progress and deletes the weights. Only Docent's own model folder is touched. */
export function removeKokoro(): ModelStatus {
  download?.abort.abort();
  download = null;
  retire();
  vocab = null;
  styles.clear();
  rmSync(modelDir(), { recursive: true, force: true });
  return kokoroStatus();
}

// ---------------------------------------------------------------- speaking

let vocab: Map<string, number> | null = null;
const styles = new Map<string, Float32Array>();
/** One line at a time: the model already uses every core, and parallel runs only slow each other down. */
let queue: Promise<unknown> = Promise.resolve();

function vocabulary(): Map<string, number> {
  if (!vocab) {
    const tok = JSON.parse(readFileSync(join(modelDir(), "tokenizer.json"), "utf8")) as { model: { vocab: Record<string, number> } };
    vocab = new Map(Object.entries(tok.model.vocab));
  }
  return vocab;
}

/**
 * The model runs in a worker thread. A line takes seconds of CPU, and on the main thread that froze the whole
 * server: it couldn't send the clip that was already made, or notice a request that was given up on.
 */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
const ready = import(pathToFileURL(workerData.ort).href).then(async (m) => {
  const ort = m.InferenceSession ? m : m.default;
  return { ort, run: await ort.InferenceSession.create(workerData.model, { executionProviders: ["cpu"] }) };
});
let chain = Promise.resolve();
parentPort.on("message", (job) => (chain = chain.then(() => say(job))));
async function say({ id, ids, style, speed }) {
  try {
    const { ort, run } = await ready;
    const out = await run.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      style: new ort.Tensor("float32", style, [1, 256]),
      speed: new ort.Tensor("float32", Float32Array.from([speed]), [1]),
    });
    parentPort.postMessage({ id, waveform: out.waveform.data, durations: out.durations ? Array.from(out.durations.data, Number) : null });
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
}`;

type Inference = { waveform: Float32Array; durations: number[] | null };
let worker: Worker | null = null;
let jobs = 0;
const pending = new Map<number, { on: Worker; resolve: (r: Inference) => void; reject: (e: unknown) => void }>();

function model(): Worker {
  if (worker) return worker;
  const ort = resolveRuntime("onnxruntime-node");
  if (!ort) throw missingRuntime();
  const w = new Worker(WORKER, { eval: true, workerData: { ort, model: join(modelDir(), MODEL_FILE) } });
  // Only this worker's lines: one stopped for a cancelled line must not fail the next worker's.
  const failAll = (e: unknown) => {
    for (const [id, p] of pending) if (p.on === w) (pending.delete(id), p.reject(e));
  };
  w.on("message", (m: Inference & { id: number; error?: string }) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new VoiceError(`Kokoro couldn't say that line: ${m.error}`));
    else p.resolve(m);
  });
  w.on("error", (e) => failAll(new VoiceError(`Kokoro stopped: ${e.message}`)));
  w.on("exit", () => {
    if (worker === w) worker = null;
    failAll(new VoiceError("Kokoro stopped"));
  });
  w.unref();
  return (worker = w);
}

/** Lets the worker go once it has no line in progress (stopping it mid-run would abort the process). */
function retire() {
  const w = worker;
  worker = null;
  if (!w) return;
  const idle = () => ![...pending.values()].some((p) => p.on === w);
  if (idle()) return void w.terminate();
  const t = setInterval(() => idle() && (clearInterval(t), void w.terminate()), 250);
}

/**
 * One run of the model. Given up on, its result is dropped; the run itself finishes, because stopping the
 * worker in the middle of one aborts the whole process (onnxruntime throws from native code).
 */
function infer(ids: number[], style: Float32Array, speed: number, signal?: AbortSignal): Promise<Inference> {
  signal?.throwIfAborted();
  const w = model();
  const id = jobs++;
  return new Promise((resolve, reject) => {
    // The entry stays until the worker answers, so it counts as busy; the answer then goes nowhere.
    let given = false;
    const stop = () => {
      given = true;
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
    pending.set(id, {
      on: w,
      resolve: (r) => (signal?.removeEventListener("abort", stop), given || resolve(r)),
      reject: (e) => (signal?.removeEventListener("abort", stop), given || reject(e)),
    });
    w.postMessage({ id, ids, style, speed });
  });
}

function style(voice: string): Float32Array {
  let s = styles.get(voice);
  if (!s) {
    const bytes = readFileSync(join(modelDir(), "voices", `${voice}.bin`));
    s = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    styles.set(voice, s);
  }
  return s;
}

/** Punctuation the model reads (as pauses and intonation); everything between is phonemized. */
const PUNCT = /(\s*[;:,.!?¡¿—…"«»“”()]+\s*)+/g;

/** espeak's output, adjusted the way kokoro-js does for Kokoro's phoneme set. */
const tidy = (p: string) => p.replace(/ʲ/g, "j").replace(/r/g, "ɹ").replace(/x/g, "k").replace(/ɬ/g, "l");

/**
 * Text to phoneme pieces, each tagged with the word (index into the line's words) it belongs to, or -1
 * for pauses and spaces.
 */
export async function phonemePieces(text: string, british: boolean): Promise<{ words: string[]; pieces: { p: string; word: number }[] }> {
  const { phonemize } = await importRuntime<typeof import("phonemizer")>("phonemizer");
  const words: string[] = [];
  const pieces: { p: string; word: number }[] = [];
  const clean = text.replace(/[‘’]/g, "'").replace(/[^\S\n]+/g, " ").trim();
  let at = 0;
  const phrase = async (s: string) => {
    const tw = s.trim().split(/\s+/).filter(Boolean);
    if (!tw.length) return;
    const first = words.length;
    words.push(...tw);
    const say = async (t: string) => (await phonemize(t, british ? "en" : "en-us")).join(" ").split(/\s+/).filter(Boolean).map(tidy);
    let pw = (await say(s)).map((p) => [p]);
    // Numbers and initials ("256", "S3") come back as several words; then each word is phonemized alone.
    if (pw.length !== tw.length) pw = await Promise.all(tw.map(say));
    pw.forEach((ps, i) => {
      if (i) pieces.push({ p: " ", word: -1 });
      pieces.push({ p: ps.join(" "), word: first + i });
    });
  };
  for (const m of clean.matchAll(PUNCT)) {
    await phrase(clean.slice(at, m.index));
    pieces.push({ p: m[0].replace(/\s+/g, " "), word: -1 });
    at = m.index + m[0].length;
  }
  await phrase(clean.slice(at));
  return { words, pieces };
}

/** Pieces to token ids (characters the vocabulary lacks are dropped), split into runs that fit the model. */
function tokenize(pieces: { p: string; word: number }[], vocab: Map<string, number>): { ids: number[]; word: number[] }[] {
  const runs: { ids: number[]; word: number[] }[] = [{ ids: [], word: [] }];
  let lastBreak = { run: 0, at: 0 };
  for (const { p, word } of pieces) {
    for (const ch of p) {
      const id = vocab.get(ch);
      if (id === undefined) continue;
      let run = runs.at(-1)!;
      if (run.ids.length >= MAX_TOKENS) {
        // Too long for one pass: cut at the last pause (or here) and carry the rest into a new run.
        const cut = lastBreak.run === runs.length - 1 && lastBreak.at > 0 ? lastBreak.at : run.ids.length;
        const next = { ids: run.ids.splice(cut), word: run.word.splice(cut) };
        runs.push(next);
        run = next;
      }
      run.ids.push(id);
      run.word.push(word);
      if (word < 0 && /[.!?;:,]/.test(ch)) lastBreak = { run: runs.length - 1, at: run.ids.length };
    }
  }
  return runs.filter((r) => r.ids.length);
}

export class KokoroAdapter implements VoiceAdapter {
  readonly id = "kokoro";

  async listVoices({ query }: { query?: string } = {}): Promise<VoiceInfo[]> {
    const q = query?.trim().toLowerCase() ?? "";
    return Object.entries(VOICES)
      .map(([id, v]) => ({ id, name: v.name, description: `${v.accent} · ${v.gender} · quality ${v.grade}`, own: false }))
      .filter((v) => !q || `${v.name} ${v.description}`.toLowerCase().includes(q));
  }

  synthesize(text: string, opts: SynthOptions): Promise<Clip> {
    const next = queue.then(() => this.run(text, opts));
    queue = next.catch(() => {});
    return next;
  }

  private async run(text: string, { voice, speed = 1, tone, signal }: SynthOptions): Promise<Clip> {
    // A line cancelled while it waited in the queue (the tour moved on) is skipped, so the next one starts sooner.
    signal?.throwIfAborted();
    if (!VOICES[voice]) throw new VoiceError(`Kokoro has no voice "${voice}"`);
    if (!kokoroReady()) throw new VoiceError("Download the Kokoro voice in Settings first");
    const vocab = vocabulary();
    const pace = Math.max(0.6, Math.min(1.5, speed * (tone ? KOKORO_PACE[tone] : 1)));
    const { words: textWords, pieces } = await phonemePieces(text, voice.startsWith("b"));
    const voiceStyle = style(voice);
    const audio: Float32Array[] = [];
    /** When each of the line's words is said, by index into `textWords`. */
    const timed: { w: number; start: number; end: number }[] = [];
    let offset = 0;
    for (const chunk of tokenize(pieces, vocab)) {
      signal?.throwIfAborted();
      const n = Math.min(chunk.ids.length, MAX_TOKENS - 1);
      const out = await infer([0, ...chunk.ids, 0], voiceStyle.slice(n * 256, n * 256 + 256), pace, signal);
      const { waveform, durations } = out;
      audio.push(waveform);
      const seconds = waveform.length / SAMPLE_RATE;
      if (durations?.length === chunk.ids.length + 2) {
        // Each token's duration is in model frames; scale them so they add up to the clip's real length.
        const d = Array.from(durations, Number);
        const perFrame = seconds / (d.reduce((a, b) => a + b, 0) || 1);
        let t = offset + d[0]! * perFrame;
        chunk.word.forEach((w, i) => {
          const dt = d[i + 1]! * perFrame;
          const last = timed.at(-1);
          if (w >= 0 && last?.w === w) last.end = t + dt;
          else if (w >= 0) timed.push({ w, start: t, end: t + dt });
          t += dt;
        });
      } else {
        const said = [...new Set(chunk.word.filter((w) => w >= 0))];
        estimateWords(said.map((w) => textWords[w]).join(" "), seconds).forEach((x, i) => timed.push({ w: said[i]!, start: x.start + offset, end: x.end + offset }));
      }
      offset += seconds;
    }
    const pcm = Buffer.alloc(audio.reduce((a, b) => a + b.length, 0) * 2);
    let i = 0;
    for (const part of audio) for (const s of part) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), (i++) * 2);
    return {
      audio: wav(pcm, SAMPLE_RATE),
      mime: "audio/wav",
      durationMs: Math.round(offset * 1000),
      words: timed.map(({ w, start, end }) => ({ word: textWords[w]!, start, end })),
    };
  }
}
