import { useEffect, useRef, useState } from "react";
import type { Settings, VoiceOption, VoiceProvider } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { invalidateAll } from "../../shared/api/useQuery.ts";
import { Icon } from "../../shared/ui/index.ts";
import "./settings.css";

const PROVIDERS: { id: VoiceProvider; name: string; keyUrl: string }[] = [
  { id: "cartesia", name: "Cartesia", keyUrl: "https://play.cartesia.ai/keys" },
  { id: "fish-audio", name: "Fish Audio", keyUrl: "https://fish.audio/app/api-keys/" },
];

/**
 * A key field that never shows the key: a masked hint of what's saved, and a password field to replace it.
 * Saving tests the key first (for voice keys, by actually speaking a word).
 */
function KeyField({ label, saved, url, onSave }: { label: string; saved: string | null; url?: string; onSave: (key: string | null) => Promise<void> }) {
  const [editing, setEditing] = useState(!saved);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setEditing(!saved), [saved]);
  const save = async (key: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(key);
      setValue("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="set-key">
      <div className="set-label">{label}{url && <a href={url} target="_blank" rel="noreferrer">Get a key</a>}</div>
      {editing ? (
        <form className="set-key-row" onSubmit={(e) => (e.preventDefault(), value.trim() && void save(value.trim()))}>
          <input type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste the key" aria-label={label} />
          <button className="set-btn" type="submit" disabled={!value.trim() || busy}>{busy ? "Checking…" : "Save"}</button>
          {saved && <button className="tbtn" type="button" onClick={() => setEditing(false)}>Cancel</button>}
        </form>
      ) : (
        <div className="set-key-row">
          <span className="set-saved"><Icon name="check" size={13} weight="bold" />{saved}</span>
          <button className="tbtn" onClick={() => setEditing(true)}>Replace</button>
          <button className="tbtn" disabled={busy} onClick={() => void save(null)}>Remove</button>
        </div>
      )}
      {error && <p className="set-error" role="alert">{error}</p>}
    </div>
  );
}

function VoicePicker({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const provider = settings.voice.provider;
  const chosen = settings.voice.voices[provider];
  const [query, setQuery] = useState("");
  const [list, setList] = useState<VoiceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const hasKey = !!settings.voice.keys[provider];

  useEffect(() => {
    if (!hasKey) return setList(null);
    let live = true;
    setError(null);
    // Clear at once: a stale list from the other provider must never be clickable.
    setList((cur) => (query ? cur : null));
    const t = setTimeout(() => {
      api.voices(provider, query).then((v) => live && setList(v), (e: Error) => live && setError(e.message));
    }, query ? 300 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [provider, query, hasKey]);
  useEffect(() => setList(null), [provider]);
  useEffect(() => () => audio.current?.pause(), []);

  const preview = async (v: VoiceOption) => {
    audio.current?.pause();
    if (playing === v.id) return setPlaying(null);
    setPlaying(v.id);
    try {
      const clip = await api.previewVoice(provider, v.id);
      const a = new Audio(clip.url);
      audio.current = a;
      a.addEventListener("ended", () => setPlaying(null));
      await a.play();
    } catch (e) {
      setError((e as Error).message);
      setPlaying(null);
    }
  };

  if (!hasKey) return <p className="set-hint">Add the key above to choose a voice.</p>;
  return (
    <div className="set-voices">
      <input className="set-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search voices" aria-label="Search voices" />
      {error && <p className="set-error" role="alert">{error}</p>}
      <div className="set-voice-list" role="listbox" aria-label="Voices">
        {list === null && !error && <p className="set-hint">Loading voices…</p>}
        {list?.length === 0 && <p className="set-hint">No voices match.</p>}
        {list?.map((v) => (
          <div key={v.id} className={`set-voice${v.id === chosen ? " on" : ""}`} role="option" aria-selected={v.id === chosen}>
            <button className="set-voice-pick" onClick={() => void api.setVoice({ voice: v.id }).then(onChange)}>
              <span className="set-voice-name">{v.name}{v.own && <em>Yours</em>}</span>
              {v.description && <span className="set-voice-desc">{v.description}</span>}
            </button>
            <button className="tbtn" onClick={() => void preview(v)} aria-label={`Preview ${v.name}`} title="Preview">
              <Icon name={playing === v.id ? "stop" : "play"} size={13} weight="bold" />
            </button>
            {v.id === chosen && <Icon name="check" size={15} weight="bold" />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Settings: the narrator (provider, key, voice, speed, expression) and how Docent reaches Claude. */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.settings().then(setS, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Anything that changes how lines sound makes cached answers (voice status, clips) out of date.
  const update = (next: Settings) => {
    setS(next);
    invalidateAll();
  };

  return (
    <div className="settings-over" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="float settings" role="dialog" aria-label="Settings">
        <div className="set-head">
          <h2>Settings</h2>
          <button className="tbtn" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>
        {error && <p className="set-error">{error}</p>}
        {s && (
          <>
            <div className="set-section">
              <h3>Narrator</h3>
              <div className="set-seg" role="radiogroup" aria-label="Voice provider">
                {PROVIDERS.map((p) => (
                  <button key={p.id} role="radio" aria-checked={s.voice.provider === p.id} onClick={() => void api.setVoice({ provider: p.id }).then(update)}>
                    {p.name}{s.voice.keys[p.id] ? "" : " · no key"}
                  </button>
                ))}
              </div>
              {PROVIDERS.filter((p) => p.id === s.voice.provider).map((p) => (
                <KeyField key={p.id} label={`${p.name} API key`} saved={s.voice.keys[p.id]} url={p.keyUrl} onSave={async (k) => update(await api.setKey(p.id, k))} />
              ))}
              <div className="set-label">Voice</div>
              <VoicePicker settings={s} onChange={update} />
              <div className="set-row">
                <label htmlFor="set-speed">Speed</label>
                <input id="set-speed" type="range" min={0.8} max={1.25} step={0.05} value={s.voice.speed} onChange={(e) => setS({ ...s, voice: { ...s.voice, speed: Number(e.target.value) } })} onPointerUp={(e) => void api.setVoice({ speed: Number((e.target as HTMLInputElement).value) }).then(update)} onKeyUp={(e) => void api.setVoice({ speed: Number((e.target as HTMLInputElement).value) }).then(update)} />
                <span className="set-val">{s.voice.speed.toFixed(2)}×</span>
              </div>
              <label className="set-row set-toggle">
                <input type="checkbox" checked={s.voice.expressive} onChange={(e) => void api.setVoice({ expressive: e.target.checked }).then(update)} />
                <span><b>Expressive</b> · the narrator sounds calm when explaining, curious when asking, concerned about risks</span>
              </label>
            </div>
            <div className="set-section">
              <h3>Claude</h3>
              <div className="set-seg" role="radiogroup" aria-label="How Docent reaches Claude">
                <button role="radio" aria-checked={s.claude.mode === "claude-code"} onClick={() => void api.setClaude("claude-code").then(update)}>Your subscription</button>
                <button role="radio" aria-checked={s.claude.mode === "api"} onClick={() => void api.setClaude("api").then(update)}>API key</button>
              </div>
              <p className="set-hint">{s.claude.describe}</p>
              {s.claude.mode === "api" && <KeyField label="Anthropic API key" saved={s.claude.apiKey} url="https://console.anthropic.com/settings/keys" onSave={async (k) => update(await api.setKey("anthropic", k))} />}
            </div>
            <p className="set-foot">Keys are saved in Docent's own <code>.env</code> (never committed, never in an analyzed repo) and never shown again in full.</p>
          </>
        )}
      </section>
    </div>
  );
}
