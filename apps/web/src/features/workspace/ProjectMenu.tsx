import { useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { Icon } from "../../shared/ui/index.ts";
import { repoHash } from "./OpenRepo.tsx";
import { where } from "./where.ts";
import "./workspace.css";

/** Opens a folder on the server, then loads its flows fresh (every view caches the open repo's data). */
async function openFolder(path: string): Promise<void> {
  const w = await api.openRepo(path);
  window.location.hash = w.current ? repoHash(w.current.name) : "#/";
  window.location.reload();
}

/**
 * The project name in the top bar, as a menu: switch to a recent project, open another folder,
 * or go back to the welcome page with every project.
 */
export function ProjectMenu({ name }: { name: string }) {
  const workspace = useQuery("workspace", api.workspace);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = [...(root.current?.querySelectorAll<HTMLButtonElement>(".pm-item:not(:disabled)") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      e.preventDefault();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    root.current?.querySelector<HTMLButtonElement>(".pm-item")?.focus();
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const go = async (label: string, run: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  const choose = () =>
    go("folder", async () => {
      const { path } = await api.pickFolder();
      if (path) await openFolder(path);
      else setBusy(null);
    });

  const recent = workspace.data?.recent ?? [];
  const current = workspace.data?.current;
  return (
    <div className="pm" ref={root}>
      <button className="bd-home-repo" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Switch project">
        <Icon name="project" size={15} />
        <span className="pm-name">{name}</span>
        <Icon name="chevron" size={13} weight="bold" />
      </button>
      {open && (
        <div className="pm-pop" role="menu" aria-label="Projects">
          <div className="pm-label">Current project</div>
          <button className="pm-item here" role="menuitem" onClick={() => setOpen(false)}>
            <span className="pm-folder"><Icon name={current ? where(current).icon : "project"} size={16} fill /></span>
            <span className="pm-t"><b>{name}</b><span>{current ? where(current).text : ""}</span></span>
            <Icon name="check" size={15} weight="bold" />
          </button>

          {recent.length > 0 && <div className="pm-label">Switch to</div>}
          {recent.map((r) => (
            <button key={r.root} className="pm-item" role="menuitem" disabled={!!busy} onClick={() => void go(r.root, () => openFolder(r.root))}>
              <span className="pm-folder"><Icon name={where(r).icon} size={16} fill /></span>
              <span className="pm-t"><b>{r.name}</b><span>{where(r).text}</span></span>
              {busy === r.root ? <span className="spinner pm-spin" aria-label="Opening" /> : <Icon name="chevron" size={14} />}
            </button>
          ))}

          <div className="pm-sep" role="separator" />
          <button className="pm-item pm-action" role="menuitem" disabled={!!busy} onClick={() => void choose()}>
            {busy === "folder" ? <span className="spinner pm-spin" aria-hidden="true" /> : <Icon name="plus" size={16} />}Open another folder…
          </button>
          <button className="pm-item pm-action" role="menuitem" disabled={!!busy} onClick={() => (window.location.hash = "#/")}>
            <Icon name="area" size={16} />All projects, GitHub or zip…
          </button>
          {error && <p className="open-error pm-err" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
