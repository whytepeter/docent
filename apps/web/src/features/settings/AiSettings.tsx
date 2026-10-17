import { useState } from "react";
import type { AiProviderInfo, Settings } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";

/** One line on whether a provider is ready on this computer. */
function readiness(p: AiProviderInfo): { text: string; ok: boolean } {
  if (p.id === "api") return p.signedIn ? { text: "Key saved", ok: true } : { text: "Needs a key", ok: false };
  if (!p.installed) return { text: "Not installed", ok: false };
  if (p.signedIn === false) return { text: "Installed, not signed in", ok: false };
  return { text: `Ready${p.detail ? ` · ${p.detail}` : ""}`, ok: true };
}

/**
 * The AI tab's provider list: the subscription CLIs this computer has (and whether each is signed in),
 * then the API key. A provider that isn't ready shows how to set it up; the user signs in themselves.
 */
export function AiProviders({ s, update, fail }: { s: Settings; update: (s: Settings) => void; fail: (e: Error) => void }) {
  const [checking, setChecking] = useState(false);
  const recheck = () => {
    setChecking(true);
    api.settings().then(update, fail).finally(() => setChecking(false));
  };
  const unready = s.ai.providers.filter((p) => p.id !== "api" && (!p.installed || p.signedIn === false));
  return (
    <>
      <div className="set-tiles col" role="radiogroup" aria-label="How Docent reaches a model">
        {s.ai.providers.map((p) => {
          const r = readiness(p);
          return (
            <button key={p.id} role="radio" aria-checked={s.ai.provider === p.id} disabled={!p.installed}
              onClick={() => void api.setAi(p.id).then(update, fail)}>
              <b>{p.name} <small className="set-vendor">{p.vendor}</small></b>
              <span>{p.id === "api" ? "Pay per use with an Anthropic key" : `Runs on your ${p.plan} plan; nothing to paste`}</span>
              <span className={r.ok ? "ok" : ""}>{r.text}</span>
            </button>
          );
        })}
      </div>
      <p className="set-hint">{s.ai.describe}</p>
      {unready.map((p) => (
        <div className="set-howto" key={p.id}>
          <p className="set-label">Set up {p.name}</p>
          <ol>
            {!p.installed && p.install && <li>Install it in a terminal: <code>{p.install}</code></li>}
            {p.signIn && <li>Sign in once with your {p.account ?? p.vendor} account: <code>{p.signIn}</code></li>}
          </ol>
          <p className="set-hint">Docent never sees your password; it only runs {p.name} the way you would. <a href={p.docs} target="_blank" rel="noreferrer">{p.name} docs</a></p>
        </div>
      ))}
      {unready.length > 0 && <button className="tbtn" onClick={recheck} disabled={checking}>{checking ? "Checking…" : "Check again"}</button>}
    </>
  );
}
