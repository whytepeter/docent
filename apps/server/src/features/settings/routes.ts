import { Hono } from "hono";
import type { LocalModel, Settings, VoiceClip, VoiceOption, VoiceStatus } from "@docent/contracts";
import { pickProvider, readConfig, writeConfig } from "@docent/llm";
import {
  adapterFor, clipAudio, CLOUD_PROVIDERS, DEFAULT_PRONUNCIATIONS, downloadKokoro, isCloud, KEY_ENV, kokoroStatus, pickVoice, PROVIDERS,
  removeKokoro, setupHint, setVoiceSettings, speak, testKey, voiceSettings, type CloudProviderId, type ProviderId,
} from "@docent/voice";
import { hint, setEnvVar } from "./env.ts";

const SAMPLE = "This part is solid. This part I wouldn't trust, and here's why.";

function settings(): Settings {
  const v = voiceSettings();
  let claude = "unavailable";
  try {
    claude = pickProvider().describe();
  } catch (e) {
    claude = (e as Error).message;
  }
  return {
    voice: {
      provider: v.provider,
      voices: v.voices,
      speed: v.speed,
      expressive: v.expressive,
      pronunciations: v.pronunciations,
      defaults: DEFAULT_PRONUNCIATIONS,
      keys: Object.fromEntries(CLOUD_PROVIDERS.map((p) => [p, hint(process.env[KEY_ENV[p]])])) as Record<CloudProviderId, string | null>,
      local: { kokoro: kokoroStatus() },
    },
    claude: { mode: readConfig().provider === "api" ? "api" : "claude-code", describe: claude, apiKey: hint(process.env.ANTHROPIC_API_KEY) },
  };
}

const isProvider = (p: unknown): p is ProviderId => typeof p === "string" && (PROVIDERS as readonly string[]).includes(p);

/**
 * Settings: API keys and the narrator. Keys are write-only from the page's point of view: they go to
 * Docent's .env (gitignored) and this process, and only a masked hint ever comes back.
 */
export function settingsRoutes(): Hono {
  return new Hono()
    .get("/settings", (c) => c.json<Settings>(settings()))
    .get("/voice", (c) => {
      const v = pickVoice();
      return c.json<VoiceStatus>("reason" in v ? { available: false, reason: v.reason } : { available: true, provider: v.adapter.id });
    })
    .get("/voice/:file", (c) => {
      const audio = clipAudio(c.req.param("file").replace(/\.wav$/, ""));
      if (!audio) return c.json({ error: "No such clip" }, 404);
      return c.body(audio as Uint8Array<ArrayBuffer>, 200, { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=31536000, immutable" });
    })
    .put("/settings/keys", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { provider?: string; key?: string | null };
      const key = typeof body.key === "string" ? body.key.trim() : null;
      if (body.provider === "anthropic") {
        setEnvVar("ANTHROPIC_API_KEY", key || null);
        return c.json<Settings>(settings());
      }
      if (!isProvider(body.provider) || !isCloud(body.provider)) return c.json({ error: "Unknown provider" }, 400);
      if (key) {
        // A key that can list voices may still be refused for speech, so a voice key is tested by speaking.
        const voice = voiceSettings().voices[body.provider];
        const test = await testKey(body.provider, key, voice);
        if (!test.ok) return c.json({ error: `That key didn't work: ${test.reason}` }, 400);
      }
      setEnvVar(KEY_ENV[body.provider], key || null);
      return c.json<Settings>(settings());
    })
    .put("/settings/voice", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { provider?: string; voice?: string; speed?: number; expressive?: boolean; pronunciations?: unknown };
      const table = body.pronunciations && typeof body.pronunciations === "object"
        ? Object.fromEntries(Object.entries(body.pronunciations as Record<string, unknown>)
          .filter(([k, v]) => typeof v === "string" && k.trim() && k.length <= 60 && v.length <= 120)
          .slice(0, 300)
          .map(([k, v]) => [k.trim(), (v as string).trim()]))
        : undefined;
      if (body.provider !== undefined && !isProvider(body.provider)) return c.json({ error: "Unknown provider" }, 400);
      setVoiceSettings({
        ...(isProvider(body.provider) ? { provider: body.provider } : {}),
        ...(typeof body.voice === "string" && body.voice ? { voice: body.voice } : {}),
        ...(typeof body.speed === "number" ? { speed: body.speed } : {}),
        ...(typeof body.expressive === "boolean" ? { expressive: body.expressive } : {}),
        ...(table ? { pronunciations: table } : {}),
      });
      return c.json<Settings>(settings());
    })
    .put("/settings/claude", async (c) => {
      const { mode } = (await c.req.json().catch(() => ({}))) as { mode?: string };
      if (mode !== "api" && mode !== "claude-code") return c.json({ error: "Unknown mode" }, 400);
      writeConfig({ ...readConfig(), provider: mode });
      return c.json<Settings>(settings());
    })
    .get("/settings/voices", async (c) => {
      const provider = c.req.query("provider");
      if (!isProvider(provider)) return c.json({ error: "Unknown provider" }, 400);
      const adapter = adapterFor(provider);
      if (!adapter?.listVoices) return c.json({ error: `${setupHint(provider)} first` }, 409);
      return c.json<VoiceOption[]>(await adapter.listVoices({ query: c.req.query("q") ?? "" }));
    })
    .post("/settings/voices/preview", async (c) => {
      const { provider, voice } = (await c.req.json().catch(() => ({}))) as { provider?: string; voice?: string };
      if (!isProvider(provider) || !voice) return c.json({ error: "Pick a voice" }, 400);
      const adapter = adapterFor(provider);
      if (!adapter) return c.json({ error: `${setupHint(provider)} first` }, 409);
      const v = voiceSettings();
      const clip = await speak(adapter, voice, SAMPLE, { speed: v.speed, ...(v.expressive ? { tone: "warm" as const } : {}) });
      return c.json<VoiceClip>({ ...clip, url: `/api/voice/${clip.hash}.wav` });
    })
    // Local voices: download the weights to ~/.docent/models (in the background; poll for progress), or delete them.
    .get("/settings/models/kokoro", (c) => c.json<LocalModel>(kokoroStatus()))
    .post("/settings/models/kokoro", (c) => c.json<LocalModel>(downloadKokoro()))
    .delete("/settings/models/kokoro", (c) => {
      removeKokoro();
      return c.json<Settings>(settings());
    });
}
