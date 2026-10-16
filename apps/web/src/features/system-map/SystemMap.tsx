import { useEffect, useMemo } from "react";
import type { Overview } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { startPrepare, useFeatures } from "../../shared/api/features.ts";
import { layoutFeatureLanes } from "../feature-map/index.ts";
import { cardHeight, Diagram, lanes } from "../../shared/graph/index.ts";
import { headerStore } from "../../shared/state/header.ts";
import { navigate } from "../../shared/state/router.ts";
import { Group } from "../../shared/ui/index.ts";
import { openCode } from "../code/index.ts";
import "./system.css";

export const useOverview = () => useQuery("overview", api.overview);

/** Layer color for an area's folder group. */
export const hueOf = (group: string | null): "app" | "features" | "components" | "shared" | "other" =>
  group === "app" || group === "features" || group === "components" || group === "shared" ? group : "other";

export function SystemCanvas() {
  const { data, error } = useOverview();
  const features = useFeatures();
  const map = features?.map ?? null;

  useEffect(() => {
    if (!data) return;
    headerStore.set({ title: data.repo.name, crumbs: [] });
    document.title = `${data.repo.name} · Docent`;
  }, [data]);

  // Real features replace the folder-based areas as soon as Claude has proposed them.
  const graph = useMemo(() => {
    if (!data || !features) return null;
    return map && features.cards.length ? layoutFeatureLanes(features) : layoutSystem(data);
  }, [data, features, map]);

  if (error) return <div className="center-msg">{error.message}</div>;
  if (!graph || !features) return <div className="center-msg"><span className="spinner" /> Reading the map…</div>;
  const entry = data?.entries.find((e) => e.kind === "browser-entry" || e.kind === "main" || e.kind === "bin");
  const running = !!features.job && !features.job.finishedAt;
  const verified = features.cards.filter((c) => c.analysis).length;
  return (
    <div className="system">
      <div className="welcome">
        <h1>{data?.repo.name}</h1>
        {!map && (
          <>
            <p>New to this code? Docent reads it, finds what it does for its users, and checks every part against the code, so nothing it tells you is a guess dressed up as fact. Takes about {Math.max(10, Math.round((data?.counts.files ?? 100) / 12))} minutes; you can start exploring as soon as the first part is ready.</p>
            <div className="welcome-actions">
              <button className="start" disabled={running} onClick={() => void startPrepare()}>
                {running ? "Getting it ready…" : "Learn this codebase"} <i aria-hidden="true">→</i>
              </button>
              {entry && <button className="ghost-btn" onClick={() => navigate({ view: "file", path: entry.file })}>Or start at {entry.file.split("/").pop()}</button>}
            </div>
          </>
        )}
        {map && (
          <>
            <p>
              {verified === map.features.length
                ? `${map.features.length} features, all checked against the code. Open one to see how it works, or watch its episode.`
                : running
                  ? `${verified} of ${map.features.length} features ready. Open any that's ready while the rest are checked.`
                  : `${map.features.length} features${verified ? `, ${verified} ready` : ""}. Point at one to see what it depends on, click to open it.`}
            </p>
            <div className="welcome-actions">
              {verified < map.features.length && !running && (
                <button className="start" onClick={() => void startPrepare()}>
                  {verified ? "Get the rest ready" : "Get every feature ready"} <i aria-hidden="true">→</i>
                </button>
              )}
              <button className="ghost-btn" onClick={() => navigate({ view: "review" })}>Edit the map</button>
            </div>
          </>
        )}
      </div>
      <div className="system-map">
        <Diagram nodes={graph.nodes} edges={graph.edges} sections={graph.sections} quietEdges topSpace={150} label={map ? "Features and how they depend on each other" : "Areas of the codebase and how they depend on each other"} />
      </div>
    </div>
  );
}

function layoutSystem(o: Overview) {
  const specs = o.areas.map((a) => ({
    id: a.id,
    lane: a.group ?? "top level",
    hue: hueOf(a.group),
    h: cardHeight({}),
    title: a.label,
    icon: "area" as const,
    meta: [
      { icon: "file" as const, value: a.files, label: "files" },
      { icon: "fn" as const, value: a.functions, label: "functions" },
      ...(a.tests ? [{ icon: "test" as const, value: a.tests, label: "tests" }] : []),
    ],
    onClick: () => navigate({ view: "area", id: a.id }),
  }));
  const links = o.links.map((l, i) => ({ id: `l${i}`, from: l.from, to: l.to, width: Math.min(3.5, 1 + Math.log2(l.count) / 2) }));
  return lanes(specs, links);
}

export function SystemInspector() {
  const { data } = useOverview();
  if (!data) return null;
  const biggest = [...data.areas].sort((a, b) => b.functions - a.functions).slice(0, 6);
  return (
    <>
      <div className="i-head">
        <div className="kick">Repository</div>
        <div className="i-title">{data.repo.name}</div>
        <div className="i-sub">{data.stack.join(" · ")}</div>
        <div className="i-meta">
          <span>{data.counts.files} files</span><span>{data.counts.functions + data.counts.components} functions</span>
          <span>{data.counts.tests} tests</span><span>{data.counts.commits} commits</span>
        </div>
      </div>
      <Group title="Where it starts" count={data.entries.length} open>
        {data.entries.map((e) => (
          <button key={`${e.kind}:${e.file}`} className="row" onClick={() => navigate({ view: "file", path: e.file })}>
            <span className="grow mono">{e.file}</span><span className="sub">{e.detail}</span>
          </button>
        ))}
      </Group>
      <Group title="Biggest areas" count={biggest.length}>
        {biggest.map((a) => (
          <button key={a.id} className="row" onClick={() => navigate({ view: "area", id: a.id })}>
            <span className="grow">{a.label}</span><span className="sub">{a.functions} fns</span>
          </button>
        ))}
      </Group>
      <div className="i-actions">
        <button className="link" onClick={() => openCode("package.json")}>package.json</button>
      </div>
    </>
  );
}

