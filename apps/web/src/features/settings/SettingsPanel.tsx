import { useEffect, useRef, useState } from "react";
import type { CloudVoiceProvider, LocalModel, LocalVoiceProvider, Settings, VoiceOption, VoiceProvider } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { invalidateAll } from "../../shared/api/useQuery.ts";
import { useStore } from "../../shared/state/store.ts";
import { themeStore, type Theme } from "../../shared/state/theme.ts";
import { Icon } from "../../shared/ui/index.ts";
import { EditorThemePicker } from "../code/index.ts";
import { AiProviders } from "./AiSettings.tsx";
import "./settings.css";

const CLOUD: { id: CloudVoiceProvider; name: string; keyUrl: string }[] = [
  { id: "cartesia", name: "Cartesia", keyUrl: "https://play.cartesia.ai/keys" },
  { id: "fish-audio", name: "Fish Audio", keyUrl: "https://fish.audio/app/api-keys/" },
];
const LOCAL: { id: LocalVoiceProvider; name: string; about: string }[] = [
  { id: "kokoro", name: "Kokoro", about: "Kokoro 82M, open weights (Apache-2.0). 28 English voices, American and British." },
];
const isLocal = (p: VoiceProvider): p is LocalVoiceProvider => LOCAL.some((l) => l.id === p);
/** A voice service you can use now: a cloud one with its key saved, or a local one downloaded. */
const usable = (s: Settings, p: VoiceProvider) => (isLocal(p) ? s.voice.local[p].state === "ready" : !!s.voice.keys[p]);
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
      {model.state === "unsupported" ? null : model.state === "ready" ? (
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

/** The provider's voices matching a search, and a preview player for them. */
function useVoices(provider: VoiceProvider, query: string, hasKey: boolean) {
  const [list, setList] = useState<VoiceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

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
  return { list, error, setError, playing, preview };
}

/** The search box and the list of voices; picking one saves it. */
function VoiceList({ settings, query, setQuery, voices, onPick }: { settings: Settings; query: string; setQuery: (q: string) => void; voices: ReturnType<typeof useVoices>; onPick: (s: Settings) => void }) {
  const chosen = settings.voice.voices[settings.voice.provider];
  const { list, error, setError, playing, preview } = voices;
  return (
    <>
      <label className="set-search">
        <Icon name="search" size={14} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search voices" aria-label="Search voices" autoFocus />
      </label>
      <div className="set-voice-list" role="listbox" aria-label="Voices">
        {list === null && !error && <p className="set-hint">Loading voices…</p>}
        {list?.length === 0 && <p className="set-hint">No voices match.</p>}
        {list?.map((v) => (
          <div key={v.id} className={`set-voice${v.id === chosen ? " on" : ""}`} role="option" aria-selected={v.id === chosen}>
            <button className="set-voice-pick" onClick={() => void api.setVoice({ voice: v.id }).then((next) => (onPick(next), setQuery("")), (e: Error) => setError(e.message))}>
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
    </>
  );
}

function VoicePicker({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const provider = settings.voice.provider;
  const chosen = settings.voice.voices[provider];
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const hasKey = usable(settings, provider);
  const voices = useVoices(provider, query, hasKey);
  const { list, error, playing, preview } = voices;
  useEffect(() => setOpen(false), [provider]);

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
          <VoiceList settings={settings} query={query} setQuery={setQuery} voices={voices} onPick={(next) => (onChange(next), setOpen(false))} />
        </div>
      )}
    </div>
  );
}

/**
 * The narrator's voice, switched from where you listen (the board's story bar): the voice services you've
 * added a key for, and the chosen service's voices. Everything else about the narrator stays in Settings.
 */
export function VoiceMenu({ onChange, onClose }: { onChange: () => void; onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const provider = s?.voice.provider ?? "cartesia";
  const voices = useVoices(provider, query, !!s && usable(s, provider));
  useEffect(() => {
    api.settings().then(setS, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const update = (next: Settings) => {
    setS(next);
    invalidateAll();
    onChange();
  };
  const pick = (p: VoiceProvider) => void api.setVoice({ provider: p }).then(update, (e: Error) => setError(e.message));
  return (
    <div className="set-menu" role="dialog" aria-label="Narrator voice">
      {error && <p className="set-error" role="alert">{error}</p>}
      {!s && !error && <p className="set-hint">Loading…</p>}
      {s && (
        <div className="set-menu-kinds" role="radiogroup" aria-label="Voice service">
          {([["Cloud", "cloud", CLOUD], ["On this computer", "local", LOCAL]] as const).map(([name, icon, list]) => (
            <div key={icon} className="set-menu-kind">
              <span><Icon name={icon} size={13} />{name}</span>
              <div className="set-seg">
                {list.map((p) => {
                  const ok = usable(s, p.id);
                  return (
                    <button key={p.id} role="radio" aria-checked={s.voice.provider === p.id} disabled={!ok && s.voice.provider !== p.id}
                      title={ok ? "" : isLocal(p.id) ? "Download it in Settings first" : "Add its key in Settings first"} onClick={() => pick(p.id)}>{p.name}</button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {s && (usable(s, provider)
        ? <VoiceList settings={s} query={query} setQuery={setQuery} voices={voices} onPick={update} />
        : <p className="set-hint">{isLocal(provider) ? "Download the voice in Settings to choose one." : "Add a voice key in Settings to choose a voice."}</p>)}
      {voices.error && <p className="set-error" role="alert">{voices.error}</p>}
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

type Tab = "narrator" | "ai" | "appearance";
const THEMES: [Theme, string, string, "screen" | "sun" | "moon"][] = [
  ["system", "System", "Follows your computer", "screen"],
  ["light", "Light", "Always light", "sun"],
  ["dark", "Dark", "Always dark", "moon"],
];
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25];

/** Settings: the narrator (provider, key, voice, speed, expression) and which AI reads the code. */
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
          {([["narrator", "Narrator", "sound"], ["ai", "AI", "claude"], ["appearance", "Appearance", "sun"]] as const).map(([id, name, icon]) => (
            <button key={id} className={tab === id ? "on" : ""} aria-current={tab === id} onClick={() => setTab(id)}>
              <Icon name={icon} size={16} />{name}
            </button>
          ))}
          <p className="set-foot"><Icon name="lock" size={13} /><span>Keys stay in Docent's own <code>.env</code> on this computer, never in a repo, and are never shown in full.</span></p>
          <a className="set-malt" href="https://buymeamalt.com/@whytepeter" target="_blank" rel="noopener noreferrer"><Icon name="malt" size={14} />Buy me a malt</a>
        </nav>
        {/* On the panel, not in the scrolling body, so it stays put however far the settings scroll. */}
        <button className="set-x" onClick={onClose} aria-label="Close" title="Close (Esc)"><Icon name="close" size={16} /></button>
        <div className="set-body">
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
                            <span className={m.state === "ready" ? "ok" : ""}>{m.state === "ready" ? "Downloaded" : m.state === "downloading" ? "Downloading…" : m.state === "unsupported" ? "Not on this computer" : `${mb(m.size)} download`}</span>
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
          {s && tab === "ai" && (
            <>
              <header className="set-h"><h3>AI</h3><p>Docent reads your code with an AI. Use a subscription you already have, or an API key.</p></header>
              <div className="set-group">
                <AiProviders s={s} update={update} fail={fail} />
                {s.ai.provider === "api" && <KeyField label="Anthropic API key" saved={s.ai.apiKey} url="https://console.anthropic.com/settings/keys" onSave={async (k) => update(await api.setKey("anthropic", k))} />}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
