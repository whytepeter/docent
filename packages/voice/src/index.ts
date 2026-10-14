import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Narration audio. One small interface so any provider plugs in; providers only ever receive
 * narration text, never code, and keys come only from the environment.
 */
/**
 * How a line is said. Provider-neutral; each adapter maps it to what its voices understand.
 * calm: explaining (the default) · warm: "this part is solid" · curious: a question ·
 * concerned: a risk, "I wouldn't trust this" · emphatic: the point to remember.
 */
export const TONES = ["calm", "warm", "curious", "concerned", "emphatic"] as const;
export type Tone = (typeof TONES)[number];

export interface SynthOptions {
  voice: string;
  /** 0.6–1.5; 1 is normal. */
  speed?: number;
  tone?: Tone;
  signal?: AbortSignal;
}

export interface VoiceAdapter {
  id: string;
  synthesize(text: string, opts: SynthOptions): Promise<Clip>;
  listVoices?(opts?: { query?: string }): Promise<VoiceInfo[]>;
}

export interface VoiceInfo {
  id: string;
  name: string;
  description?: string;
  /** A voice from the user's own account (cloned or created), not the public library. */
  own: boolean;
}

/** A spoken line: the audio, its length, and when each word is said (seconds from the start). */
export interface Clip {
  audio: Uint8Array;
  mime: string;
  durationMs: number;
  words: { word: string; start: number; end: number }[];
}

export class VoiceError extends Error {}

// ---------------------------------------------------------------- Cartesia

const CARTESIA_URL = "https://api.cartesia.ai/tts/sse";
const CARTESIA_VERSION = "2026-08-14";
const SAMPLE_RATE = 24000;
const CARTESIA_TONES: Record<Tone, { emotion: string; speed?: number }> = {
  calm: { emotion: "calm" },
  warm: { emotion: "content" },
  curious: { emotion: "curious" },
  concerned: { emotion: "neutral", speed: 0.92 },
  emphatic: { emotion: "excited", speed: 0.97 },
};

export class CartesiaAdapter implements VoiceAdapter {
  readonly id = "cartesia";
  constructor(private readonly key: string, private readonly model = "sonic-3.6") {}

  headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, "Cartesia-Version": CARTESIA_VERSION };
  }

  /** Voices to choose from: the user's own first, then the public library. */
  async listVoices({ query }: { query?: string } = {}): Promise<VoiceInfo[]> {
    const get = async (qs: string) => {
      const res = await fetch(`https://api.cartesia.ai/voices?${qs}`, { headers: this.headers() });
      if (!res.ok) throw new VoiceError(`Cartesia answered ${res.status} listing voices`);
      return ((await res.json()) as { data?: { id: string; name: string; description?: string; is_owner?: boolean }[] }).data ?? [];
    };
    const q = query?.trim() ? `&q=${encodeURIComponent(query.trim())}` : "";
    const [own, all] = await Promise.all([get(`is_owner=true&limit=100${q}`), get(`limit=60${q}`)]);
    const mine = new Set(own.map((v) => v.id));
    return [...own, ...all.filter((v) => !mine.has(v.id))].map((v) => ({ id: v.id, name: v.name, ...(v.description ? { description: v.description } : {}), own: mine.has(v.id) }));
  }

  async synthesize(text: string, { voice, speed = 1, tone, signal }: SynthOptions): Promise<Clip> {
    // Cartesia's best-supported emotions are calm, content and curious; concern reads as a slower, neutral delivery.
    const delivery = tone ? CARTESIA_TONES[tone] : null;
    const pace = Math.max(0.6, Math.min(1.5, speed * (delivery?.speed ?? 1)));
    const res = await fetch(CARTESIA_URL, {
      method: "POST",
      signal,
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        model_id: this.model,
        transcript: text,
        voice: { id: voice },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
        add_timestamps: true,
        language: "en",
        generation_config: { speed: Number(pace.toFixed(2)), ...(delivery ? { emotion: delivery.emotion } : {}) },
      }),
    });
    if (!res.ok || !res.body) throw new VoiceError(`Cartesia answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const pcm: Uint8Array[] = [];
    const words: Clip["words"] = [];
    let buffer = "";
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data) continue;
        const e = JSON.parse(data) as {
          type: string; data?: string; message?: string; title?: string;
          word_timestamps?: { words: string[]; start: number[]; end: number[] };
        };
        if (e.type === "chunk" && e.data) pcm.push(Uint8Array.from(Buffer.from(e.data, "base64")));
        else if (e.type === "timestamps" && e.word_timestamps) {
          const t = e.word_timestamps;
          t.words.forEach((word, i) => words.push({ word, start: t.start[i] ?? 0, end: t.end[i] ?? 0 }));
        } else if (e.type === "error") throw new VoiceError(`Cartesia: ${e.title ?? ""} ${e.message ?? ""}`.trim());
      }
    }
    const samples = Buffer.concat(pcm);
    return { audio: wav(samples, SAMPLE_RATE), mime: "audio/wav", durationMs: Math.round((samples.length / 2 / SAMPLE_RATE) * 1000), words };
  }
}

// ---------------------------------------------------------------- Fish Audio

const FISH_URL = "https://api.fish.audio";
const FISH_FREE_MODEL = "s2.1-pro-free";
/** S2 voices take free-form cues in square brackets at the start of a line. */
const FISH_TONES: Record<Tone, string> = { calm: "[calm]", warm: "[warm]", curious: "[curious]", concerned: "[serious]", emphatic: "[emphasis]" };

export class FishAudioAdapter implements VoiceAdapter {
  readonly id = "fish-audio";
  constructor(private readonly key: string, private readonly model = "s2.1-pro") {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.key}` };
  }

  /** Without API credit (402) Fish still serves its free developer model; once seen, that's what this process uses. */
  private static noCredit = false;

  async synthesize(text: string, opts: SynthOptions): Promise<Clip> {
    const model = FishAudioAdapter.noCredit ? FISH_FREE_MODEL : this.model;
    try {
      return await this.request(text, opts, model);
    } catch (e) {
      if (!(e instanceof VoiceError) || !e.message.includes(" 402") || model === FISH_FREE_MODEL) throw e;
      FishAudioAdapter.noCredit = true;
      return this.request(text, opts, FISH_FREE_MODEL);
    }
  }

  private async request(text: string, { voice, speed = 1, tone, signal }: SynthOptions, model: string): Promise<Clip> {
    const res = await fetch(`${FISH_URL}/v1/tts`, {
      method: "POST",
      signal,
      headers: { ...this.headers(), "Content-Type": "application/json", model },
      body: JSON.stringify({
        text: tone ? `${FISH_TONES[tone]} ${text}` : text,
        reference_id: voice,
        format: "wav",
        sample_rate: SAMPLE_RATE,
        prosody: { speed: Math.max(0.5, Math.min(2, speed)) },
        latency: "normal",
      }),
    });
    if (!res.ok) throw new VoiceError(`Fish Audio answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const audio = new Uint8Array(await res.arrayBuffer());
    const durationMs = wavDurationMs(audio);
    // Fish returns no word timings, so words are spread over the real clip length by their length.
    return { audio, mime: "audio/wav", durationMs, words: estimateWords(text, durationMs / 1000) };
  }

  /** Voices to choose from: the user's own first, then popular public ones. */
  async listVoices({ query }: { query?: string } = {}): Promise<VoiceInfo[]> {
    const get = async (qs: string) => {
      const res = await fetch(`${FISH_URL}/model?${qs}`, { headers: this.headers() });
      if (!res.ok) throw new VoiceError(`Fish Audio answered ${res.status} listing voices`);
      return ((await res.json()) as { items?: { _id: string; title: string; description?: string }[] }).items ?? [];
    };
    const q = query?.trim() ? `&title=${encodeURIComponent(query.trim())}` : "";
    const [own, all] = await Promise.all([get(`self=true&page_size=100${q}`), get(`page_size=40&sort_by=score&language=en${q}`)]);
    const mine = new Set(own.map((v) => v._id));
    return [...own, ...all.filter((v) => !mine.has(v._id))].map((v) => ({ id: v._id, name: v.title, ...(v.description ? { description: v.description.slice(0, 140) } : {}), own: mine.has(v._id) }));
  }
}

/** Length of a PCM WAV from its header: data bytes over bytes per second. */
export function wavDurationMs(wavBytes: Uint8Array): number {
  const b = Buffer.from(wavBytes);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF") return 0;
  const byteRate = b.readUInt32LE(28);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    // Streamed WAVs may leave the data size unset; then the rest of the file is the data.
    if (id === "data") return Math.round((Math.min(size || Infinity, b.length - at - 8) / byteRate) * 1000);
    at += 8 + size;
  }
  return 0;
}

/** Word timings when a provider gives none: spread over the clip in proportion to each word's length. */
export function estimateWords(text: string, seconds: number): Clip["words"] {
  const words = text.split(/\s+/).filter(Boolean);
  const weight = words.map((w) => w.length + 2);
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  const lead = Math.min(0.15, seconds * 0.03);
  const span = Math.max(0, seconds - lead * 2);
  let t = lead;
  return words.map((word, i) => {
    const d = (weight[i]! / total) * span;
    const out = { word, start: t, end: t + d };
    t += d;
    return out;
  });
}

/** Wraps 16-bit mono PCM in a WAV header so the browser can play it as is. */
export function wav(pcm: Uint8Array, rate: number): Uint8Array {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Uint8Array.from(Buffer.concat([h, pcm]));
}

// ---------------------------------------------------------------- choosing and caching

export const PROVIDERS = ["cartesia", "fish-audio"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
/** Where each provider's key comes from (Docent's .env or the shell). */
export const KEY_ENV: Record<ProviderId, string> = { cartesia: "CARTESIA_API_KEY", "fish-audio": "FISH_AUDIO_API_KEY" };
/** Cartesia "Ricardo", the brief's starting narrator. Fish Audio has no default: pick one in Settings. */
const DEFAULT_VOICES: Partial<Record<ProviderId, string>> = { cartesia: "8499aae3-022c-4d55-8283-0c2e8adbefb4" };

interface VoiceConfig {
  voice?: { provider?: string; voice?: string; voices?: Partial<Record<ProviderId, string>>; speed?: number; expressive?: boolean };
}

const configFile = () => join(homedir(), ".docent", "config.json");
function readConfig(): Record<string, unknown> & VoiceConfig {
  try {
    return JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, unknown> & VoiceConfig;
  } catch {
    return {};
  }
}

export interface VoiceSettings {
  provider: ProviderId;
  /** The chosen voice for each provider, so switching back and forth keeps each choice. */
  voices: Partial<Record<ProviderId, string>>;
  /** Overall narration speed, 0.8–1.25. */
  speed: number;
  /** Whether each line's tone (calm, curious, concerned…) shapes the delivery. */
  expressive: boolean;
}

/** The narrator settings from ~/.docent/config.json, with defaults. */
export function voiceSettings(): VoiceSettings {
  const v = readConfig().voice ?? {};
  const provider: ProviderId = (PROVIDERS as readonly string[]).includes(v.provider ?? "") ? (v.provider as ProviderId) : "cartesia";
  // Older configs kept one `voice` for the active provider.
  const voices = { ...DEFAULT_VOICES, ...(v.voice ? { [provider]: v.voice } : {}), ...v.voices };
  return { provider, voices, speed: v.speed ?? 1, expressive: v.expressive ?? true };
}

/** Saves narrator settings, keeping everything else in the config. */
export function setVoiceSettings(patch: { provider?: ProviderId; voice?: string; speed?: number; expressive?: boolean }): VoiceSettings {
  const config = readConfig();
  const cur = voiceSettings();
  const provider = patch.provider ?? cur.provider;
  const next: VoiceSettings = {
    provider,
    voices: patch.voice ? { ...cur.voices, [provider]: patch.voice } : cur.voices,
    speed: Math.max(0.8, Math.min(1.25, patch.speed ?? cur.speed)),
    expressive: patch.expressive ?? cur.expressive,
  };
  mkdirSync(join(homedir(), ".docent"), { recursive: true });
  writeFileSync(configFile(), `${JSON.stringify({ ...config, voice: next }, null, 2)}\n`);
  return next;
}

/** An adapter for a provider, if its key is set. */
export function adapterFor(provider: ProviderId, key = process.env[KEY_ENV[provider]]): VoiceAdapter | null {
  if (!key) return null;
  return provider === "fish-audio" ? new FishAudioAdapter(key) : new CartesiaAdapter(key);
}

/** The configured narrator, or why there isn't one. */
export function pickVoice(): { adapter: VoiceAdapter; voice: string; speed: number; expressive: boolean } | { reason: string } {
  const { provider, voices, speed, expressive } = voiceSettings();
  const adapter = adapterFor(provider);
  const name = provider === "fish-audio" ? "Fish Audio" : "Cartesia";
  if (!adapter) return { reason: `Add a ${name} API key in Settings to hear the narration` };
  const voice = voices[provider];
  if (!voice) return { reason: `Choose a ${name} voice in Settings` };
  return { adapter, voice, speed, expressive };
}

/** Checks a key can actually speak (some keys can list voices but not synthesize). */
export async function testKey(provider: ProviderId, key: string, voice?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const adapter = adapterFor(provider, key)!;
  try {
    if (voice) await adapter.synthesize("Ready.", { voice });
    else await adapter.listVoices?.();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

const cacheDir = () => {
  const dir = join(homedir(), ".docent", "voice");
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Clips are cached by text + provider + voice + delivery, so changing one sentence regenerates one clip. */
export const clipHash = (text: string, provider: string, voice: string, delivery = "") =>
  createHash("sha256").update(`${provider}\n${voice}\n${delivery}\n${text}`).digest("hex").slice(0, 24);

export interface CachedClip {
  hash: string;
  durationMs: number;
  words: Clip["words"];
}

export async function speak(
  adapter: VoiceAdapter,
  voice: string,
  text: string,
  { speed = 1, tone, signal }: { speed?: number; tone?: Tone; signal?: AbortSignal } = {},
): Promise<CachedClip> {
  const delivery = speed === 1 && !tone ? "" : `${speed}:${tone ?? ""}`;
  const hash = clipHash(text, adapter.id, voice, delivery);
  const meta = join(cacheDir(), `${hash}.json`);
  if (existsSync(meta) && existsSync(join(cacheDir(), `${hash}.wav`))) return JSON.parse(readFileSync(meta, "utf8")) as CachedClip;
  const clip = await adapter.synthesize(text, { voice, speed, ...(tone ? { tone } : {}), ...(signal ? { signal } : {}) });
  writeFileSync(join(cacheDir(), `${hash}.wav`), clip.audio);
  const out: CachedClip = { hash, durationMs: clip.durationMs, words: clip.words };
  writeFileSync(meta, JSON.stringify(out));
  return out;
}

/** The cached audio for a clip hash, or null. Hashes are hex only, so nothing outside the cache can be read. */
export function clipAudio(hash: string): Uint8Array | null {
  if (!/^[0-9a-f]{24}$/.test(hash)) return null;
  const file = join(cacheDir(), `${hash}.wav`);
  return existsSync(file) ? readFileSync(file) : null;
}
