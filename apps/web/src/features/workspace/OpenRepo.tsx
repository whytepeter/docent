import { useEffect, useRef, useState } from "react";
import type { Workspace } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { Icon, Logo, ThemeButton } from "../../shared/ui/index.ts";
import "./workspace.css";

/** A codebase's flows live at #/repo/<name>, and one flow's board at #/repo/<name>/board/<id>. */
export const repoHash = (name: string, board?: string) =>
  `#/repo/${encodeURIComponent(name)}${board ? `/board/${encodeURIComponent(board)}` : ""}`;

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s) || s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString();
}

const STEPS = [
  { icon: "system", title: "Finds the flows", text: "Reads the code and picks out what the app actually does." },
  { icon: "play", title: "Draws each one", text: "A whiteboard you can tour step by step, built from real files." },
  { icon: "ask", title: "Answers with evidence", text: "Ask anything. Every claim points at the code behind it." },
] as const;

/**
 * What was dropped: a folder's name and a few of its entries. Browsers never give a page the full path,
 * so the server finds the folder on disk from these. Must start inside the drop handler, before any await.
 */
function readDrop(data: DataTransfer): Promise<{ name: string; children: string[] } | "file" | null> {
  const item = [...data.items].find((i) => i.kind === "file");
  const entry = item?.webkitGetAsEntry();
  if (!entry) return Promise.resolve(null);
  if (!entry.isDirectory) return Promise.resolve("file");
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  return new Promise((ok) => {
    reader.readEntries(
      (kids) => {
        const names = kids.map((k) => k.name).sort((a, b) => Number(a.startsWith(".")) - Number(b.startsWith(".")));
        ok({ name: entry.name, children: names.slice(0, 12) });
      },
      () => ok({ name: entry.name, children: [] }),
    );
  });
}

/** True while files are dragged over the window. A counter, because dragleave fires for every child crossed. */
function useDragging(): boolean {
  const [on, setOn] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const files = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      depth.current += 1;
      setOn(true);
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOn(false);
    };
    const over = (e: DragEvent) => {
      if (files(e)) e.preventDefault();
    };
    const end = () => {
      depth.current = 0;
      setOn(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", end);
    };
  }, []);
  return on;
}

/**
 * The welcome page at #/: open a codebase by dropping its folder, the macOS folder dialog or a pasted path,
 * or pick one opened before. Every view caches data for the open repo, so opening one is a fresh page load.
 */
export function OpenRepo({ workspace, onSettings }: { workspace: Workspace; onSettings: () => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<{ name: string; paths: string[] } | null>(null);
  const dragging = useDragging();

  useEffect(() => {
    document.title = "Docent";
  }, []);

  const open = async (folder: string) => {
    setError(null);
    setChoices(null);
    setBusy(folder.split("/").filter(Boolean).pop() ?? folder);
    try {
      const w = await api.openRepo(folder);
      window.location.hash = w.current ? repoHash(w.current.name) : "#/";
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const choose = async () => {
    setError(null);
    setChoices(null);
    try {
      const { path: picked } = await api.pickFolder();
      if (picked) await open(picked);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const drop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setChoices(null);
    const dropped = await readDrop(e.dataTransfer);
    if (!dropped) return;
    if (dropped === "file") return setError("That’s a file. Drop the project’s folder instead.");
    setBusy(dropped.name);
    try {
      const { paths } = await api.findDropped(dropped.name, dropped.children);
      if (paths.length === 1) return void (await open(paths[0]!));
      setBusy(null);
      if (paths.length) setChoices({ name: dropped.name, paths });
      else setError(`Couldn’t find “${dropped.name}” on this Mac. Use Choose a folder… or paste its path.`);
    } catch (err) {
      setBusy(null);
      setError((err as Error).message);
    }
  };

  const current = workspace.current;
  const projects = [...(current ? [{ ...current, openedAt: "" }] : []), ...workspace.recent];
  return (
    <main className={`bd-home welcome${dragging ? " dragging" : ""}`} onDrop={(e) => void drop(e)} onDragOver={(e) => e.preventDefault()}>
      <header className="bd-home-bar">
        <span className="bd-home-brand" aria-label="docent"><Logo size={16} /><span className="bd-home-word">docent</span></span>
        <ThemeButton className="bd-home-gear bd-home-theme" />
        <button className="bd-home-gear" onClick={onSettings} aria-label="Settings" title="Settings: voice, keys"><Icon name="settings" size={18} /></button>
      </header>
      <div className="wel-body">
        <section className="wel-hero">
          <h1>Learn a codebase<br />on a whiteboard.</h1>
          <p>Open a project folder. Docent finds its main flows and draws each one from the real code, so you can tour it, ask about it and check what’s true.</p>
        </section>

        <section className={`wel-open${dragging ? " on" : ""}`} aria-label="Open a codebase">
          {busy ? (
            <div className="open-busy" role="status">
              <span className="spinner" aria-hidden="true" />
              <div><b>Reading {busy}</b><span>The first time takes a few seconds; after that it’s cached.</span></div>
            </div>
          ) : (
            <>
              <div className="wel-drop">
                <span className="wel-drop-i" aria-hidden="true"><Icon name={dragging ? "drop" : "project"} size={22} /></span>
                <div className="wel-drop-t">
                  <b>{dragging ? "Drop to open it" : "Drop a project folder"}</b>
                  <span>{dragging ? "Docent finds it on this Mac and reads it." : "Anywhere on this page, or pick one from your Mac."}</span>
                </div>
                <button className="open-choose" onClick={() => void choose()} autoFocus>
                  <Icon name="folder" size={16} />Choose…
                </button>
              </div>
              <form className="open-path" onSubmit={(e) => { e.preventDefault(); if (path.trim()) void open(path.trim()); }}>
                <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="or paste a path, like ~/code/my-app" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="Folder path" />
                <button type="submit" disabled={!path.trim()} aria-label="Open this path" title="Open this path"><Icon name="send" size={15} weight="bold" /></button>
              </form>
              {choices && (
                <div className="wel-choices" role="group" aria-label={`Folders named ${choices.name}`}>
                  <p>More than one folder is called “{choices.name}”. Which one?</p>
                  {choices.paths.map((p) => (
                    <button key={p} className="wel-choice" onClick={() => void open(p)}>
                      <Icon name="project" size={15} /><span>{home(p)}</span><Icon name="chevron" size={14} />
                    </button>
                  ))}
                </div>
              )}
              {error && <p className="open-error" role="alert">{error}</p>}
              <p className="wel-safe"><Icon name="lock" size={13} />Read-only. Docent never writes to your folder.</p>
            </>
          )}
        </section>

        {projects.length > 0 ? (
          <section className="wel-recent" aria-labelledby="wel-recent-t">
            <h2 id="wel-recent-t" className="open-label">Recent projects</h2>
            <div className="wel-grid">
              {projects.map((r) => {
                const here = r.root === current?.root;
                return (
                  <button
                    key={r.root}
                    className={`wel-proj${here ? " here" : ""}`}
                    disabled={!!busy}
                    onClick={() => (here ? (window.location.hash = repoHash(r.name)) : void open(r.root))}
                    title={home(r.root)}
                  >
                    <span className="wel-folder" aria-hidden="true"><Icon name="project" size={20} fill /></span>
                    <span className="open-item-t"><b>{r.name}</b><span>{home(r.root)}</span></span>
                    <span className="wel-when">{here ? <em>open</em> : ago(r.openedAt)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : (
          <section className="wel-steps" aria-label="How it works">
            {STEPS.map((s, i) => (
              <div key={s.title} className="wel-step">
                <span className="wel-step-i" aria-hidden="true"><Icon name={s.icon} size={17} /></span>
                <b><span className="wel-step-n">{i + 1}</span>{s.title}</b>
                <span>{s.text}</span>
              </div>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
