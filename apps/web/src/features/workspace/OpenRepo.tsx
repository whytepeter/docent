import { useState } from "react";
import type { Workspace } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { Icon } from "../../shared/ui/index.ts";
import "./workspace.css";

/** Every view caches data for the open repo, so a fresh page is the honest way to switch. */
function showRepo() {
  window.location.hash = "#/";
  window.location.reload();
}

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

/**
 * Choose which codebase Docent shows: the macOS folder dialog, a pasted path, or one opened before.
 * Shown on its own when nothing is open, and over the canvas when switching.
 */
export function OpenRepo({ workspace, onClose }: { workspace: Workspace | undefined; onClose?: () => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (folder: string) => {
    setError(null);
    setBusy(folder.split("/").filter(Boolean).pop() ?? folder);
    try {
      await api.openRepo(folder);
      showRepo();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const choose = async () => {
    setError(null);
    try {
      const { path: picked } = await api.pickFolder();
      if (picked) await open(picked);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const recent = workspace?.recent ?? [];
  return (
    <div className={`open-repo${onClose ? " over" : ""}`} onClick={onClose && ((e) => e.target === e.currentTarget && !busy && onClose())}>
      <section className="open-card float" aria-label="Open a codebase">
        <div className="open-head">
          <span className="brand-mark" aria-hidden="true">d</span>
          <div>
            <h1>Open a codebase</h1>
            <p>Docent reads the folder and never writes to it.</p>
          </div>
          {onClose && !busy && <button className="tbtn" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>}
        </div>

        {busy ? (
          <div className="open-busy" role="status">
            <span className="spinner" aria-hidden="true" />
            <div><b>Reading {busy}</b><span>The first time takes a few seconds; after that it's cached.</span></div>
          </div>
        ) : (
          <>
            <button className="open-choose" onClick={() => void choose()} autoFocus>
              <Icon name="folder" size={18} />Choose a folder…
            </button>
            <form className="open-path" onSubmit={(e) => { e.preventDefault(); if (path.trim()) void open(path); }}>
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="or paste a path, e.g. ~/code/my-app" spellCheck={false} aria-label="Folder path" />
              <button className="tbtn" type="submit" disabled={!path.trim()}>Open</button>
            </form>
            {error && <p className="open-error" role="alert">{error}</p>}
            {recent.length > 0 && (
              <div className="open-recent">
                <div className="open-label">Recent</div>
                {recent.map((r) => (
                  <button key={r.root} className="open-item" onClick={() => void open(r.root)}>
                    <b>{r.name}</b><span>{home(r.root)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
