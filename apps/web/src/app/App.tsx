import { useEffect, useState, useSyncExternalStore } from "react";
import { BoardScreen, Tray } from "../features/board/index.ts";
import { CodeSheet } from "../features/code/index.ts";
import { Home } from "../features/home/index.ts";
import { SettingsPanel } from "../features/settings/index.ts";
import { Booting, OpenRepo, ProjectMenu, ServerDown, repoHash } from "../features/workspace/index.ts";
import { api } from "../shared/api/client.ts";
import { useQuery } from "../shared/api/useQuery.ts";

/**
 * Three places: the welcome page (#/), a codebase's flows (#/repo/<name>),
 * and one flow's whiteboard (#/repo/<name>/board/<id>).
 */
type Route = { page: "welcome" } | { page: "repo"; name: string; board: string | null } | { page: "legacy-board"; board: string };

const subscribe = (l: () => void) => (window.addEventListener("hashchange", l), () => window.removeEventListener("hashchange", l));
function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const repo = /^#\/repo\/([^/]+)(?:\/board\/(.+))?$/.exec(hash);
  if (repo) return { page: "repo", name: decodeURIComponent(repo[1]!), board: repo[2] ? decodeURIComponent(repo[2]) : null };
  const old = /^#\/board\/(.+)$/.exec(hash);
  if (old) return { page: "legacy-board", board: decodeURIComponent(old[1]!) };
  return { page: "welcome" };
}
const go = (hash: string) => {
  if (window.location.hash !== hash) window.location.hash = hash;
};

/** Docent is a whiteboard: pick a flow of the codebase, and it's drawn from the real code and Docent takes you through it. */
export function App() {
  const workspace = useQuery("workspace", api.workspace);
  const route = useRoute();
  const [settings, setSettings] = useState(false);
  const repo = workspace.data?.current;
  const wanted = route.page === "repo" ? route.name : null;
  const showing = repo && wanted === repo.name ? repo : null;

  // Old links (#/board/<id>) belong to whichever codebase is open.
  useEffect(() => {
    if (route.page === "legacy-board" && workspace.data) go(repo ? repoHash(repo.name, route.board) : "#/");
  }, [route, workspace.data, repo]);

  // The address names a codebase the server isn't on (a bookmark, Back): open it if it's a recent one.
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => {
    if (!workspace.data || !wanted || wanted === repo?.name) return;
    const known = workspace.data.recent.find((r) => r.name === wanted);
    if (!known) return go("#/");
    setOpening(wanted);
    api.openRepo(known.root).then(() => window.location.reload(), () => go("#/"));
  }, [workspace.data, wanted, repo]);

  // The server shows one codebase for every tab. If another tab switches it, go back to the welcome page
  // rather than reopening this one, so two tabs never fight over it.
  const shownRoot = showing?.root;
  useEffect(() => {
    if (!shownRoot) return;
    const check = () => {
      if (document.hidden) return;
      api.workspace().then((w) => {
        if (w.current?.root !== shownRoot) {
          window.location.hash = "#/";
          window.location.reload();
        }
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
    if (showing) document.title = `${showing.name} · docent`;
  }, [showing]);

  if (workspace.error) return <ServerDown message={workspace.error.message} />;
  if (!workspace.data) return <Booting />;
  const settingsPanel = settings && <SettingsPanel onClose={() => setSettings(false)} />;
  if (route.page === "welcome") return <><OpenRepo workspace={workspace.data} onSettings={() => setSettings(true)} />{settingsPanel}</>;
  if (!showing) return <Booting label={opening ? `Opening ${opening}…` : undefined} />;
  const board = route.page === "repo" ? route.board : null;
  const openBoard = (id: string) => go(repoHash(showing.name, id));
  return (
    <>
      {board
        ? <BoardScreen key={board} id={board} repoName={showing.name} onHome={() => go(repoHash(showing.name))} onSettings={() => setSettings(true)} />
        : <Home repoName={showing.name} switcher={<ProjectMenu name={showing.name} />} onOpen={openBoard} onBack={() => go("#/")} onSettings={() => setSettings(true)} />}
      <Tray current={board} onOpen={openBoard} />
      {settingsPanel}
      <CodeSheet />
    </>
  );
}
