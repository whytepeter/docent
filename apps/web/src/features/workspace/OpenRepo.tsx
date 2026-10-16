import { useEffect, useState } from "react";
import type { Workspace } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { Icon, Logo } from "../../shared/ui/index.ts";
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

  const close = !busy ? onClose : undefined;
  useEffect(() => {
    if (!close) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

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

  const current = workspace?.current?.root;
  const recent = workspace?.recent ?? [];
  return (
    <div className={`open-repo${onClose ? " over" : ""}`} onClick={close && ((e) => e.target === e.currentTarget && close())}>
      <section className="open-card" role="dialog" aria-modal={!!onClose} aria-labelledby="open-title">
        <div className="open-head">
          <span className="open-mark" aria-hidden="true"><Logo size={42} /></span>
          <div>
            <h1 id="open-title">Open a codebase</h1>
            <p>Docent reads the folder. It never writes to it.</p>
          </div>
          {close && <button className="open-x" onClick={close} aria-label="Close"><Icon name="close" size={16} /></button>}
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
            <form className="open-path" onSubmit={(e) => { e.preventDefault(); if (path.trim()) void open(path.trim()); }}>
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="or paste a path, like ~/code/my-app" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="Folder path" />
              <button type="submit" disabled={!path.trim()} aria-label="Open this path" title="Open this path"><Icon name="send" size={15} weight="bold" /></button>
            </form>
            {error && <p className="open-error" role="alert">{error}</p>}
            {recent.length > 0 && (
              <div className="open-recent">
                <div className="open-label">Recent</div>
                {recent.map((r) => {
                  const here = r.root === current;
                  return (
                    <button key={r.root} className={`open-item${here ? " here" : ""}`} onClick={() => (here && close ? close() : void open(r.root))} title={here ? "Open now" : `Open ${r.name}`}>
                      <span className="open-ava" aria-hidden="true">{r.name.slice(0, 1).toUpperCase()}</span>
                      <span className="open-item-t"><b>{r.name}</b><span>{home(r.root)}</span></span>
                      {here ? <em>open now</em> : <Icon name="chevron" size={14} />}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
