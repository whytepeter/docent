import { useEffect, useRef, useState } from "react";
import type { CloudVoiceProvider, LocalModel, LocalVoiceProvider, Settings, VoiceOption, VoiceProvider } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { invalidateAll } from "../../shared/api/useQuery.ts";
import { useStore } from "../../shared/state/store.ts";
import { themeStore, type Theme } from "../../shared/state/theme.ts";
import { Icon } from "../../shared/ui/index.ts";
import { EditorThemePicker } from "../code/index.ts";
import "./settings.css";

const CLOUD: { id: CloudVoiceProvider; name: string; keyUrl: string }[] = [
  { id: "cartesia", name: "Cartesia", keyUrl: "https://play.cartesia.ai/keys" },
  { id: "fish-audio", name: "Fish Audio", keyUrl: "https://fish.audio/app/api-keys/" },
];
const LOCAL: { id: LocalVoiceProvider; name: string; about: string }[] = [
  { id: "kokoro", name: "Kokoro", about: "Kokoro 82M, open weights (Apache-2.0). 28 English voices, American and British." },
];
const isLocal = (p: VoiceProvider): p is LocalVoiceProvider => LOCAL.some((l) => l.id === p);
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/**
 * A voice model that runs on this computer: download it (with progress), stop, or remove it.
 * While a download runs the panel asks for progress twice a second; when it lands, settings refresh.
 */
function LocalModelCard({ about, model, onChange, onSettings }: { about: string; model: LocalModel; onChange: (m: LocalModel) => void; onSettings: (s: Settings) => void }) {
  const [error, setError] = useState<string | null>(null);
  const downloading = model.state === "downloading";
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(() => {
      api.model().then((m) => {
        onChange(m);
        if (m.state === "ready") void api.settings().then(onSettings);
      }, (e: Error) => setError(e.message));
    }, 500);
    return () => clearInterval(t);
  }, [downloading]);
  const pct = Math.min(100, Math.round((model.received / Math.max(1, model.size)) * 100));
  const act = (p: Promise<unknown>) => (setError(null), p.catch((e: Error) => setError(e.message)));
  return (
    <div className="set-model">
      <p className="set-hint">{about}</p>
      {model.state === "ready" ? (
        <div className="set-key-row">
          <span className="set-saved"><Icon name="check" size={13} weight="bold" />Downloaded<code>{mb(model.size)} · works offline</code></span>
          <button className="tbtn" onClick={() => void act(api.removeModel().then(onSettings))}>Remove</button>
        </div>
      ) : downloading ? (
        <div className="set-key-row">
          <div className="set-progress" role="progressbar" aria-label="Downloading the voice" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
            <em>{mb(model.received)} of {mb(model.size)}</em>
          </div>
          <button className="tbtn" onClick={() => void act(api.removeModel().then(onSettings))}>Stop</button>
        </div>
      ) : (
        <div className="set-key-row">
          <button className="set-btn set-btn-icon" onClick={() => void act(api.downloadModel().then(onChange))}>
            <Icon name="download" size={14} weight="bold" />{model.state === "error" ? "Try again" : "Download"} · {mb(model.size)}
          </button>
          <span className="set-hint">From Hugging Face, kept in <code>~/.docent/models</code></span>
        </div>
      )}
      {(error ?? model.error) && <p className="set-error" role="alert">{error ?? model.error}</p>}
    </div>
  );
}

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
          <span className="set-saved"><Icon name="check" size={13} weight="bold" />Saved<code>{saved}</code></span>
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
  const [open, setOpen] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const hasKey = isLocal(provider) ? settings.voice.local[provider].state === "ready" : !!settings.voice.keys[provider];

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
  useEffect(() => {
    setList(null);
    setOpen(false);
  }, [provider]);
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

  if (!hasKey) return <p className="set-hint">{isLocal(provider) ? "Download the voice above to choose one." : "Add the key above to choose a voice."}</p>;
  const current = list?.find((v) => v.id === chosen);
  return (
    <div className="set-voices">
      <div className={`set-select${open ? " open" : ""}`}>
        <button className="set-select-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox">
          <span className="set-voice-name">{current?.name ?? (chosen ? "Your chosen voice" : "Choose a voice")}{current?.own && <em>Yours</em>}</span>
          {current?.description && <span className="set-voice-desc">{current.description}</span>}
        </button>
        {current && (
          <button className="tbtn" onClick={() => void preview(current)} aria-label={`Preview ${current.name}`} title="Preview">
            <Icon name={playing === current.id ? "stop" : "play"} size={13} weight="bold" />
          </button>
        )}
        <button className="tbtn set-select-chev" onClick={() => setOpen((o) => !o)} aria-label={open ? "Close the list" : "Change voice"}><Icon name="chevron" size={15} /></button>
      </div>
      {error && <p className="set-error" role="alert">{error}</p>}
      {open && (
        <div className="set-drop">
          <label className="set-search">
            <Icon name="search" size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search voices" aria-label="Search voices" autoFocus />
          </label>
          <div className="set-voice-list" role="listbox" aria-label="Voices">
            {list === null && !error && <p className="set-hint">Loading voices…</p>}
            {list?.length === 0 && <p className="set-hint">No voices match.</p>}
            {list?.map((v) => (
              <div key={v.id} className={`set-voice${v.id === chosen ? " on" : ""}`} role="option" aria-selected={v.id === chosen}>
                <button className="set-voice-pick" onClick={() => void api.setVoice({ voice: v.id }).then((next) => (onChange(next), setOpen(false), setQuery("")))}>
                  <span className="set-voice-name">{v.name}{v.own && <em>Yours</em>}</span>
                  {v.description && <span className="set-voice-desc">{v.description}</span>}
                </button>
                <button className="tbtn" onClick={() => void preview(v)} aria-label={`Preview ${v.name}`} title="Preview">
                  <Icon name={playing === v.id ? "stop" : "play"} size={13} weight="bold" />
                </button>
                <span className="set-voice-tick">{v.id === chosen && <Icon name="check" size={15} weight="bold" />}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const toText = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `${k} = ${v}`).join("\n");
const fromText = (text: string) =>
  Object.fromEntries(text.split("\n").map((l) => l.split("=")).filter((p) => p.length >= 2 && p[0]!.trim()).map(([k, ...v]) => [k!.trim(), v.join("=").trim()]));

/** The narrator's pronunciation table: one "term = how to say it" per line, on top of the defaults. */
function Pronunciations({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [text, setText] = useState(toText(settings.voice.pronunciations));
  const [saved, setSaved] = useState(false);
  const dirty = text !== toText(settings.voice.pronunciations);
  return (
    <details className="set-pron">
      <summary><span><b>Pronunciations</b><small>How the narrator says names and jargon</small></span><Icon name="chevron" size={14} /></summary>
      <p className="set-hint">One per line: <code>term = how to say it</code>. Only the voice changes; the screen keeps the real word. Built in: {Object.keys(settings.voice.defaults).join(", ")}.</p>
      <textarea rows={4} spellCheck={false} value={text} placeholder={"Applicant API = applicant A P I\nnonce = nonss"} onChange={(e) => (setText(e.target.value), setSaved(false))} aria-label="Pronunciations" />
      <div className="set-key-row">
        <button className="set-btn" disabled={!dirty} onClick={() => void api.setVoice({ pronunciations: fromText(text) }).then((s) => (onChange(s), setText(toText(s.voice.pronunciations)), setSaved(true)))}>Save</button>
        {saved && !dirty && <span className="set-hint">Saved. Lines that change are spoken again; the rest stay cached.</span>}
      </div>
    </details>
  );
}

type Tab = "narrator" | "claude" | "appearance";
const THEMES: [Theme, string, string, "screen" | "sun" | "moon"][] = [
  ["system", "System", "Follows your computer", "screen"],
  ["light", "Light", "Always light", "sun"],
  ["dark", "Dark", "Always dark", "moon"],
];
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25];

/** Settings: the narrator (provider, key, voice, speed, expression) and how Docent reaches Claude. */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("narrator");
  /** Which kind of voice the narrator tab shows; follows the chosen provider until you switch. */
  const [kind, setKind] = useState<"cloud" | "local" | null>(null);
  const theme = useStore(themeStore);
  useEffect(() => {
    api.settings().then(setS, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Anything that changes how lines sound makes cached answers (voice status, clips) out of date.
  const update = (next: Settings) => {
    setS(next);
    invalidateAll();
  };
  const fail = (e: Error) => setError(e.message);
  const shown = kind ?? (s && isLocal(s.voice.provider) ? "local" : "cloud");

  return (
    <div className="settings-over" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="settings" role="dialog" aria-modal="true" aria-labelledby="set-title">
        <nav className="set-nav" aria-label="Settings sections">
          <h2 id="set-title">Settings</h2>
          {([["narrator", "Narrator", "sound"], ["claude", "Claude", "claude"], ["appearance", "Appearance", "sun"]] as const).map(([id, name, icon]) => (
            <button key={id} className={tab === id ? "on" : ""} aria-current={tab === id} onClick={() => setTab(id)}>
              <Icon name={icon} size={16} />{name}
            </button>
          ))}
          <p className="set-foot"><Icon name="lock" size={13} /><span>Keys stay in Docent's own <code>.env</code> on this computer, never in a repo, and are never shown in full.</span></p>
        </nav>
        <div className="set-body">
          <button className="set-x" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
          {error && <p className="set-error" role="alert">{error}</p>}
          {!s && !error && tab !== "appearance" && <p className="set-hint">Loading…</p>}
          {s && tab === "narrator" && (
            <>
              <header className="set-h">
                <h3>Narrator</h3>
                <p>{isLocal(s.voice.provider) ? "The voice that reads the tour. It runs on this computer, so nothing is sent anywhere." : "The voice that reads the tour. Only the narration text is sent to the voice service."}</p>
              </header>
              <div className="set-group">
                <div className="set-line set-kind">
                  <span><b>Voice service</b><small>{shown === "cloud" ? "Best quality; needs a key and a connection" : "Free and offline after a one-time download"}</small></span>
                  <div className="set-seg" role="radiogroup" aria-label="Kind of voice">
                    {([["cloud", "Cloud", "cloud"], ["local", "On this computer", "local"]] as const).map(([id, name, icon]) => (
                      <button key={id} role="radio" aria-checked={shown === id} onClick={() => setKind(id)}><Icon name={icon} size={14} />{name}</button>
                    ))}
                  </div>
                </div>
                {shown === "cloud" ? (
                  <>
                    <div className="set-tiles" role="radiogroup" aria-label="Cloud voice service">
                      {CLOUD.map((p) => (
                        <button key={p.id} role="radio" aria-checked={s.voice.provider === p.id} onClick={() => void api.setVoice({ provider: p.id }).then(update, fail)}>
                          <b>{p.name}</b>
                          <span className={s.voice.keys[p.id] ? "ok" : ""}>{s.voice.keys[p.id] ? "Key saved" : "No key yet"}</span>
                        </button>
                      ))}
                    </div>
                    {CLOUD.filter((p) => p.id === s.voice.provider).map((p) => (
                      <KeyField key={p.id} label={`${p.name} API key`} saved={s.voice.keys[p.id]} url={p.keyUrl} onSave={async (k) => update(await api.setKey(p.id, k))} />
                    ))}
                  </>
                ) : (
                  <>
                    <div className="set-tiles" role="radiogroup" aria-label="Local voice">
                      {LOCAL.map((p) => {
                        const m = s.voice.local[p.id];
                        return (
                          <button key={p.id} role="radio" aria-checked={s.voice.provider === p.id} onClick={() => void api.setVoice({ provider: p.id }).then(update, fail)}>
                            <b>{p.name}</b>
                            <span className={m.state === "ready" ? "ok" : ""}>{m.state === "ready" ? "Downloaded" : m.state === "downloading" ? "Downloading…" : `${mb(m.size)} download`}</span>
                          </button>
                        );
                      })}
                    </div>
                    {LOCAL.filter((p) => p.id === s.voice.provider).map((p) => (
                      <LocalModelCard key={p.id} about={p.about} model={s.voice.local[p.id]} onSettings={update}
                        onChange={(m) => setS((cur) => cur && { ...cur, voice: { ...cur.voice, local: { ...cur.voice.local, [p.id]: m } } })} />
                    ))}
                  </>
                )}
              </div>
              <div className="set-group">
                <div className="set-label">Voice</div>
                {(shown === "local") === isLocal(s.voice.provider)
                  ? <VoicePicker settings={s} onChange={update} />
                  : <p className="set-hint">The narrator is still {[...CLOUD, ...LOCAL].find((p) => p.id === s.voice.provider)?.name}. Pick a service above to switch; each keeps its own voice.</p>}
              </div>
              <div className="set-group">
                <div className="set-label">Delivery</div>
                <div className="set-line">
                  <span><b>Speed</b><small>How fast the voice speaks; the tour's 1.25× button adds on top</small></span>
                  <div className="set-seg" role="radiogroup" aria-label="Speed">
                    {SPEEDS.map((v) => (
                      <button key={v} role="radio" aria-checked={Math.abs(s.voice.speed - v) < 0.01} onClick={() => void api.setVoice({ speed: v }).then(update, fail)}>{v}×</button>
                    ))}
                  </div>
                </div>
                <label className="set-line">
                  <span><b>Expressive</b><small>Calm when explaining, curious when asking, concerned about risks</small></span>
                  <input className="set-switch" type="checkbox" role="switch" checked={s.voice.expressive} onChange={(e) => void api.setVoice({ expressive: e.target.checked }).then(update, fail)} />
                </label>
                <Pronunciations settings={s} onChange={update} />
              </div>
            </>
          )}
          {tab === "appearance" && (
            <>
              <header className="set-h"><h3>Appearance</h3><p>Light or dark, for this browser. The button next to the gear steps through these too.</p></header>
              <div className="set-group">
                <div className="set-tiles three" role="radiogroup" aria-label="Theme">
                  {THEMES.map(([id, name, hint, icon]) => (
                    <button key={id} role="radio" aria-checked={theme === id} onClick={() => themeStore.set(id)}>
                      <Icon name={icon} size={18} />
                      <b>{name}</b><span>{hint}</span>
                    </button>
                  ))}
                </div>
              </div>
              <p className="set-label">Editor theme</p>
              <p className="set-hint">How code looks on the cards and in the code sheet, whichever theme the page is in.</p>
              <EditorThemePicker />
            </>
          )}
          {s && tab === "claude" && (
            <>
              <header className="set-h"><h3>Claude</h3><p>Docent reads your code with Claude. Choose how it signs in.</p></header>
              <div className="set-group">
                <div className="set-tiles col" role="radiogroup" aria-label="How Docent reaches Claude">
                  <button role="radio" aria-checked={s.claude.mode === "claude-code"} onClick={() => void api.setClaude("claude-code").then(update, fail)}>
                    <b>Your subscription</b><span>Uses Claude Code on this computer; nothing to paste</span>
                  </button>
                  <button role="radio" aria-checked={s.claude.mode === "api"} onClick={() => void api.setClaude("api").then(update, fail)}>
                    <b>API key</b><span>Pay per use with an Anthropic key</span>
                  </button>
                </div>
                <p className="set-hint">{s.claude.describe}</p>
                {s.claude.mode === "api" && <KeyField label="Anthropic API key" saved={s.claude.apiKey} url="https://console.anthropic.com/settings/keys" onSave={async (k) => update(await api.setKey("anthropic", k))} />}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
