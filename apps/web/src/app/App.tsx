import { useEffect, useState, useSyncExternalStore } from "react";
import { BoardScreen, Tray } from "../features/board/index.ts";
import { CodeSheet } from "../features/code/index.ts";
import { Home } from "../features/home/index.ts";
import { SettingsPanel } from "../features/settings/index.ts";
import { OpenRepo } from "../features/workspace/index.ts";
import { api } from "../shared/api/client.ts";
import { useQuery } from "../shared/api/useQuery.ts";

/** Two places: the flows of a codebase (#/), and one flow's whiteboard (#/board/<id>). */
const subscribe = (l: () => void) => (window.addEventListener("hashchange", l), () => window.removeEventListener("hashchange", l));
function useBoardId(): string | null {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const m = /^#\/board\/(.+)$/.exec(hash);
  return m ? decodeURIComponent(m[1]!) : null;
}
const go = (hash: string) => {
  if (window.location.hash !== hash) window.location.hash = hash;
};

/** Docent is a whiteboard: pick a flow of the codebase, and it's drawn from the real code to tour, break and defend. */
export function App() {
  const workspace = useQuery("workspace", api.workspace);
  const boardId = useBoardId();
  const [switching, setSwitching] = useState(false);
  const [settings, setSettings] = useState(false);
  const repo = workspace.data?.current;

  // The server shows one codebase for every tab. If it switches (another tab, a restart), start over on it.
  const shownRoot = repo?.root;
  useEffect(() => {
    if (!shownRoot) return;
    const check = () => {
      if (document.hidden) return;
      api.workspace().then((w) => {
        if (w.current?.root !== shownRoot) window.location.reload();
      }, () => {});
    };
    const t = setInterval(check, 4000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", check);
    };
  }, [shownRoot]);
  useEffect(() => {
    if (repo) document.title = `${repo.name} · Docent`;
  }, [repo]);

  if (workspace.error) return <div className="center-msg" style={{ height: "100%" }}>Can’t reach the Docent server: {workspace.error.message}</div>;
  if (!workspace.data) return null;
  if (!repo) return <OpenRepo workspace={workspace.data} />;
  return (
    <>
      {boardId
        ? <BoardScreen key={boardId} id={boardId} repoName={repo.name} onHome={() => go("#/")} onSettings={() => setSettings(true)} />
        : <Home repoName={repo.name} onOpen={(id) => go(`#/board/${encodeURIComponent(id)}`)} onSwitch={() => setSwitching(true)} onSettings={() => setSettings(true)} />}
      <Tray current={boardId ?? null} onOpen={(id) => go(`#/board/${encodeURIComponent(id)}`)} />
      {settings && <SettingsPanel onClose={() => setSettings(false)} />}
      {switching && <OpenRepo workspace={workspace.data} onClose={() => setSwitching(false)} />}
      <CodeSheet />
    </>
  );
}
