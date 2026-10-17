import { useEffect, useRef, useState } from "react";
import type { CloneJob, Workspace } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { Icon, Logo, ThemeButton, type IconName } from "../../shared/ui/index.ts";
import { home, where } from "./where.ts";
import "./workspace.css";

/** A codebase's flows live at #/repo/<name>, and one flow's board at #/repo/<name>/board/<id>. */
export const repoHash = (name: string, board?: string) =>
  `#/repo/${encodeURIComponent(name)}${board ? `/board/${encodeURIComponent(board)}` : ""}`;

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
 * What was dropped: a zip, or a folder's name and a few of its entries. Browsers never give a page the full path,
 * so the server finds the folder on disk from these. Must start inside the drop handler, before any await.
 */
function readDrop(data: DataTransfer): Promise<{ name: string; children: string[] } | { zip: File } | "file" | null> {
  const item = [...data.items].find((i) => i.kind === "file");
  const entry = item?.webkitGetAsEntry();
  if (!entry) return Promise.resolve(null);
  if (!entry.isDirectory) {
    const file = item?.getAsFile();
    return Promise.resolve(file && isZip(file) ? { zip: file } : "file");
  }
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

const isZip = (f: File) => /\.zip$/i.test(f.name) || f.type === "application/zip" || f.type === "application/x-zip-compressed";
const looksGithub = (s: string) => /^(https?:\/\/)?(www\.)?github\.com\/|^git@github\.com:/i.test(s.trim());
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

type Tab = "folder" | "github" | "zip";
const TABS: { id: Tab; icon: IconName; label: string }[] = [
  { id: "folder", icon: "project", label: "Folder" },
  { id: "github", icon: "git", label: "GitHub" },
  { id: "zip", icon: "zip", label: "Zip" },
];
const TAB_KEY = "docent.openTab";

/** Asks the welcome page to open on one tab next time (the project menu's "From GitHub or a zip…"). */
export function tabHint(tab: Tab): void {
  try {
    sessionStorage.setItem(TAB_KEY, tab);
  } catch {
    /* storage blocked: the page opens on Folder */
  }
}
function readTab(): Tab {
  try {
    const t = sessionStorage.getItem(TAB_KEY);
    return t === "github" || t === "zip" ? t : "folder";
  } catch {
    return "folder";
  }
}

const SAFE: Record<Tab, string> = {
  folder: "Read-only. Docent never writes to your folder.",
  github: "Read-only. Docent never runs the repo’s code or installs its packages.",
  zip: "Unpacked into ~/.docent/imports. Nothing in it is run.",
};

/**
 * The welcome page at #/: open a codebase from a folder on this Mac (drop it, the folder dialog or a pasted path),
 * a GitHub URL (cloned into ~/.docent/checkouts) or a zip (unpacked into ~/.docent/imports), or pick one opened before.
 * Every view caches data for the open repo, so opening one is a fresh page load.
 */
export function OpenRepo({ workspace, onSettings }: { workspace: Workspace; onSettings: () => void }) {
  const [tab, setTab] = useState<Tab>(readTab);
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<{ title: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<{ name: string; paths: string[] } | null>(null);
  const [clone, setClone] = useState<CloneJob | null>(null);
  const [have, setHave] = useState<{ repo: string; path: string; url: string } | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const dragging = useDragging();

  useEffect(() => {
    document.title = "Docent";
    tabHint("folder");
  }, []);

  const reset = () => {
    setError(null);
    setChoices(null);
    setHave(null);
  };
  const fail = (e: unknown) => {
    setError((e as Error).message);
    setBusy(null);
    setClone(null);
  };
  const go = (w: Workspace) => {
    window.location.hash = w.current ? repoHash(w.current.name) : "#/";
    window.location.reload();
  };

  const open = async (folder: string) => {
    reset();
    setBusy({ title: `Reading ${folder.split("/").filter(Boolean).pop() ?? folder}`, note: "The first time takes a few seconds; after that it’s cached." });
    try {
      go(await api.openRepo(folder));
    } catch (e) {
      fail(e);
    }
  };

  /** Follows a clone or pull until git is done, then opens the checkout. */
  const follow = async (start: CloneJob) => {
    let job = start;
    setClone(job);
    while (!job.done) {
      await sleep(400);
      job = await api.cloneJob(job.id);
      setClone(job);
    }
    setClone(null);
    if (job.error) throw new Error(job.error);
    await open(job.path!);
  };

  const github = async (input: string, pull = false) => {
    reset();
    setTab("github");
    setBusy({ title: `Finding ${input.trim()}`, note: "Asking GitHub." });
    try {
      if (pull) return void (await follow(await api.pullGithub(input)));
      const r = await api.github(input);
      setBusy(null);
      if (r.status === "exists") return setHave({ repo: r.repo, path: r.path, url: input });
      await follow(r.job);
    } catch (e) {
      fail(e);
    }
  };

  const unzip = async (file: File) => {
    reset();
    setTab("zip");
    setBusy({ title: `Unpacking ${file.name}`, note: "Then Docent reads it. The first time takes a few seconds." });
    try {
      go(await api.importZip(file));
    } catch (e) {
      fail(e);
    }
  };

  const choose = async () => {
    reset();
    try {
      const { path: picked } = await api.pickFolder();
      if (picked) await open(picked);
    } catch (e) {
      fail(e);
    }
  };

  const drop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (busy || clone) return;
    reset();
    const dropped = await readDrop(e.dataTransfer);
    if (!dropped) return;
    if (dropped === "file") return setError("That’s a file. Drop the project’s folder, or a .zip of it.");
    if ("zip" in dropped) return void (await unzip(dropped.zip));
    setTab("folder");
    setBusy({ title: `Finding ${dropped.name}`, note: "Looking for it on this Mac." });
    try {
      const { paths } = await api.findDropped(dropped.name, dropped.children);
      if (paths.length === 1) return void (await open(paths[0]!));
      setBusy(null);
      if (paths.length) setChoices({ name: dropped.name, paths });
      else setError(`Couldn’t find “${dropped.name}” on this Mac. Use Choose a folder… or paste its path.`);
    } catch (err) {
      fail(err);
    }
  };

  const current = workspace.current;
  const projects = [...(current ? [{ ...current, openedAt: "" }] : []), ...workspace.recent];
  const working = !!busy || !!clone;
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
          <p>Open a project folder, a GitHub repo or a zip. Docent finds its main flows and draws each one from the real code, so you can tour it, ask about it and check what’s true.</p>
        </section>

        <section className={`wel-open${dragging ? " on" : ""}`} aria-label="Open a codebase">
          {clone ? (
            <div className="open-clone" role="status">
              <div className="open-busy">
                <span className="spinner" aria-hidden="true" />
                <div>
                  <b>{clone.action === "pull" ? "Pulling" : "Cloning"} {clone.repo}</b>
                  <span>{clone.stage}{clone.percent !== null ? ` · ${clone.percent}%` : "…"}</span>
                </div>
              </div>
              <div className="open-bar" aria-hidden="true"><i style={{ width: `${clone.percent ?? 2}%` }} /></div>
              <span className="open-clone-note">With its full history, so Docent can read why things changed. Big repos take a minute.</span>
            </div>
          ) : busy ? (
            <div className="open-busy" role="status">
              <span className="spinner" aria-hidden="true" />
              <div><b>{busy.title}</b><span>{busy.note}</span></div>
            </div>
          ) : (
            <>
              <div className="wel-tabs" role="tablist" aria-label="Open from">
                {TABS.map((t) => (
                  <button key={t.id} role="tab" aria-selected={tab === t.id} className={`wel-tab${tab === t.id ? " on" : ""}`} onClick={() => { reset(); setTab(t.id); }}>
                    <Icon name={t.icon} size={15} />{t.label}
                  </button>
                ))}
              </div>

              {tab === "folder" && (
                <div role="tabpanel" aria-label="Folder">
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
                  <form className="open-path" onSubmit={(e) => { e.preventDefault(); const p = path.trim(); if (p) void (looksGithub(p) ? github(p) : open(p)); }}>
                    <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="or paste a path, like ~/code/my-app" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="Folder path" />
                    <button type="submit" disabled={!path.trim()} aria-label="Open this path" title="Open this path"><Icon name="send" size={15} weight="bold" /></button>
                  </form>
                </div>
              )}

              {tab === "github" && (
                <div role="tabpanel" aria-label="GitHub">
                  {have ? (
                    <div className="wel-have">
                      <p><b>Docent already has a copy of {have.repo}.</b> Pull the latest commits first, or open the copy as it is.</p>
                      <div className="wel-have-acts">
                        <button className="open-choose" onClick={() => void github(have.url, true)} autoFocus><Icon name="refresh" size={15} />Pull latest and open</button>
                        <button className="wel-btn" onClick={() => void open(have.path)}>Open as it is</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <form className="open-path wel-url" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void github(url); }}>
                        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="GitHub repo URL" autoFocus />
                        <button type="submit" disabled={!url.trim()} aria-label="Clone and open" title="Clone and open"><Icon name="send" size={15} weight="bold" /></button>
                      </form>
                      <p className="wel-note">Also owner/repo, an SSH address or a branch URL (…/tree/branch). Docent keeps a full clone in ~/.docent/checkouts. Private repos use your own git sign-in: a credential helper, SSH keys or gh. Docent never asks for a token.</p>
                    </>
                  )}
                </div>
              )}

              {tab === "zip" && (
                <div role="tabpanel" aria-label="Zip">
                  <div className="wel-drop">
                    <span className="wel-drop-i" aria-hidden="true"><Icon name="zip" size={22} /></span>
                    <div className="wel-drop-t">
                      <b>{dragging ? "Drop to open it" : "Drop a .zip of a project"}</b>
                      <span>Anywhere on this page, or pick one from your Mac.</span>
                    </div>
                    <button className="open-choose" onClick={() => zipInput.current?.click()} autoFocus>
                      <Icon name="zip" size={16} />Choose…
                    </button>
                    <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void unzip(f); }} />
                  </div>
                  <p className="wel-note"><b>A zip has no git history.</b> Docent can’t say why code changed (that comes from commit messages) or which files usually change together. Flows, boards and Ask Docent work the same. If the project is on GitHub, open it from there instead.</p>
                </div>
              )}

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
              <p className="wel-safe"><Icon name="lock" size={13} />{SAFE[tab]}</p>
            </>
          )}
        </section>

        {projects.length > 0 ? (
          <section className="wel-recent" aria-labelledby="wel-recent-t">
            <h2 id="wel-recent-t" className="open-label">Recent projects</h2>
            <div className="wel-grid">
              {projects.map((r) => {
                const here = r.root === current?.root;
                const w = where(r);
                return (
                  <button
                    key={r.root}
                    className={`wel-proj${here ? " here" : ""}`}
                    disabled={working}
                    onClick={() => (here ? (window.location.hash = repoHash(r.name)) : void open(r.root))}
                    title={w.title}
                  >
                    <span className="wel-folder" aria-hidden="true"><Icon name={w.icon} size={20} fill={w.icon === "project"} /></span>
                    <span className="open-item-t"><b>{r.name}</b><span>{w.text}</span></span>
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
