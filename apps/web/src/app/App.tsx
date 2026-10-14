import { Fragment, useEffect, useState } from "react";
import type { Route } from "@docent/contracts";
import { AreaCanvas, AreaInspector } from "../features/area-view/index.ts";
import { AskPanel } from "../features/ask/index.ts";
import { CodeSheet } from "../features/code/index.ts";
import { FileCanvas, FileInspector } from "../features/file-view/index.ts";
import { Freshness } from "../features/freshness/index.ts";
import { FunctionCanvas, FunctionInspector } from "../features/function-view/index.ts";
import { FeatureCanvas, FeatureInspector } from "../features/feature-view/index.ts";
import { ReviewCanvas, ReviewPanel } from "../features/feature-review/index.ts";
import { JobPill } from "../features/jobs/index.ts";
import { HealthButton } from "../features/health/index.ts";
import { Navigator } from "../features/navigator/index.ts";
import { openSearch, SearchPalette } from "../features/search/index.ts";
import { SystemCanvas, useOverview } from "../features/system-map/index.ts";
import { OpenRepo } from "../features/workspace/index.ts";
import { api } from "../shared/api/client.ts";
import { useQuery } from "../shared/api/useQuery.ts";
import { insets, inspectorVisible, sidebarStore } from "../shared/state/chrome.ts";
import { headerStore } from "../shared/state/header.ts";
import { inspectorStore } from "../shared/state/inspector.ts";
import { navigate, useRoute } from "../shared/state/router.ts";
import { useStore } from "../shared/state/store.ts";
import { Icon } from "../shared/ui/index.ts";
import "./shell.css";

function views(route: Route) {
  switch (route.view) {
    case "fn": return { canvas: <FunctionCanvas id={route.id} />, inspector: <FunctionInspector id={route.id} /> };
    case "file": return { canvas: <FileCanvas path={route.path} />, inspector: <FileInspector path={route.path} /> };
    case "area": return { canvas: <AreaCanvas id={route.id} />, inspector: <AreaInspector id={route.id} /> };
    case "feature": return { canvas: <FeatureCanvas id={route.id} />, inspector: <FeatureInspector id={route.id} /> };
    case "review": return { canvas: <ReviewCanvas />, inspector: <ReviewPanel /> };
    default: return { canvas: <SystemCanvas />, inspector: null };
  }
}

const toggleSidebar = () => sidebarStore.set((v) => !v);
const toggleDetails = () => inspectorStore.set((s) => ({ ...s, open: !s.open }));

/**
 * The whole window is the canvas. Everything else floats above it and gets out of the way:
 * the map on the left, location and search on top, details on the right.
 */
export function App() {
  const route = useRoute();
  const workspace = useQuery("workspace", api.workspace);
  const [switching, setSwitching] = useState(false);
  const [asking, setAsking] = useState(false);
  const { data: overview, error } = useOverview();
  const { open } = useStore(inspectorStore);
  const sidebarOpen = useStore(sidebarStore);
  const header = useStore(headerStore);
  const { canvas, inspector } = views(route);
  const key = JSON.stringify(route);
  const detailsShown = open && !!inspector;
  const inset = insets(sidebarOpen, detailsShown);

  useEffect(() => inspectorVisible.set(detailsShown), [detailsShown]);

  // The server shows one codebase for every tab. If it switches (another tab, a restart),
  // this page's cached views describe the wrong repo, so start over on the new one.
  const shownRoot = workspace.data?.current?.root;
  useEffect(() => {
    if (!shownRoot) return;
    const check = () => {
      if (document.hidden) return;
      api.workspace().then((w) => {
        if (w.current?.root !== shownRoot) window.location.reload();
      }, () => {});
    };
    const timer = setInterval(check, 4000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [shownRoot]);

  // [ toggles the map, ] toggles details, ⌘\ hides or shows all panels (as in Figma).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        const anyOpen = sidebarStore.get() || inspectorStore.get().open;
        sidebarStore.set(!anyOpen);
        inspectorStore.set((s) => ({ ...s, open: !anyOpen }));
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === "[") toggleSidebar();
      else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === "]") toggleDetails();
      else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === "/") (e.preventDefault(), setAsking((v) => !v));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (workspace.error) return <div className="center-msg" style={{ height: "100%" }}>Can’t reach the Docent server: {workspace.error.message}</div>;
  if (!workspace.data) return null;
  if (!workspace.data.current) return <OpenRepo workspace={workspace.data} />;
  if (error) return <div className="center-msg" style={{ height: "100%" }}>Can’t reach the Docent server: {error.message}</div>;

  return (
    <div className="stage" style={{ ["--inset-left" as string]: `${inset.left}px`, ["--inset-right" as string]: `${inset.right}px` }}>
      <main className="canvas" key={key} aria-label="Canvas">{canvas}</main>

      <Navigator repoName={overview?.repo.name ?? "…"} head={overview?.repo.head ?? null} onOpenRepo={() => setSwitching(true)} />

      <div className="topbar">
        <div className="float location">
          <div className="where">
            {header.crumbs.map((c, i) => (
              <Fragment key={i}>
                <button className="crumb" onClick={() => navigate(c.route)}>{c.label}</button>
                <span className="sep" aria-hidden="true">/</span>
              </Fragment>
            ))}
            <b className={route.view === "file" || route.view === "fn" ? "mono" : ""}>{header.title}</b>
          </div>
          <button className="search-pill" onClick={openSearch} aria-label="Search (⌘K)">
            <Icon name="search" size={15} /><span>Find anything</span><kbd>⌘K</kbd>
          </button>
        </div>
      </div>

      <div className="float corner">
        <button className="tbtn" aria-pressed={asking} title="Ask Docent ( / )" onClick={() => setAsking((v) => !v)}>
          <Icon name="ask" />
        </button>
        <Freshness />
        <HealthButton />
        {inspector && (
          <button className="tbtn" aria-pressed={open} title="Details ( ] )" onClick={toggleDetails}>
            <Icon name="inspector" />
          </button>
        )}
      </div>

      {inspector && (
        <aside className={`float details${detailsShown ? " shown" : ""}`} aria-label="Details" aria-hidden={!detailsShown}>
          <div className="details-in" key={key}>{inspector}</div>
        </aside>
      )}

      {asking && route.view !== "review" ? <AskPanel route={route} onClose={() => setAsking(false)} /> : <JobPill />}
      <CodeSheet />
      <SearchPalette />
      {switching && <OpenRepo workspace={workspace.data} onClose={() => setSwitching(false)} />}
    </div>
  );
}
