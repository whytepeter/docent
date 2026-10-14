import { useEffect, useState } from "react";
import type { AreaView } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { cardHeight, Diagram, hueFromPath, lanes, type DiagramEdge, type DiagramNode, type DiagramSection } from "../../shared/graph/index.ts";
import { headerStore } from "../../shared/state/header.ts";
import { navigate } from "../../shared/state/router.ts";
import { Group } from "../../shared/ui/index.ts";

const useArea = (id: string) => useQuery(`area:${id}`, () => api.area(id));
const NEIGHBOURS = 5;

export function AreaCanvas({ id }: { id: string }) {
  const { data, error } = useArea(id);
  const [graph, setGraph] = useState<{ nodes: DiagramNode[]; edges: DiagramEdge[]; sections: DiagramSection[] } | null>(null);

  useEffect(() => {
    if (!data) return;
    headerStore.set({ title: data.area.label, subtitle: data.area.path, crumbs: [] });
    document.title = `${data.area.label} · Docent`;
    let live = true;
    layoutArea(data).then((g) => live && setGraph(g));
    return () => {
      live = false;
    };
  }, [data]);

  if (error) return <div className="center-msg">{error.message}</div>;
  if (!graph) return <div className="center-msg"><span className="spinner" /></div>;
  return <Diagram nodes={graph.nodes} edges={graph.edges} sections={graph.sections} quietEdges label={`Files in ${data?.area.label}`} />;
}

/**
 * An area as framed groups: its files grouped by subfolder (components, hooks, lib…), with the
 * areas that use it on the left and the areas it uses on the right. Links appear on hover.
 */
function layoutArea(view: AreaView) {
  const name = (path: string) => path.split("/").pop()!;
  const files = view.files.filter((f) => !/\.(test|spec)\./.test(f.path));
  const sub = (path: string) => {
    const rest = path.slice(view.area.path.length + 1).split("/");
    return rest.length > 1 ? rest[0]! : "files";
  };
  const areaHue = hueFromPath(`${view.area.path}/x`);
  const specs = [
    ...view.inbound.slice(0, NEIGHBOURS).map((l) => ({
      id: `area:${l.from}`, lane: "used by", title: l.from.split("/").pop()!, sub: `${l.count} imports`, tone: "ghost" as const, icon: "area" as const, hue: hueFromPath(`${l.from}/x`),
      h: cardHeight({}), onClick: () => navigate({ view: "area", id: l.from }),
    })),
    ...files.map((f) => ({
      id: f.path, lane: sub(f.path), title: name(f.path), mono: true, hue: areaHue, icon: "file" as const,
      meta: [
        ...(f.functions ? [{ icon: "fn" as const, value: f.functions, label: f.functions > 1 ? "functions" : "function" }] : []),
        ...(f.importers ? [{ icon: "used" as const, value: f.importers, label: "files use it" }] : []),
        ...(f.tests ? [{ icon: "test" as const, value: f.tests, label: "tests" }] : []),
      ],
      sub: f.unreferenced ? "nothing imports it" : "no functions",
      tone: f.unreferenced ? "warn" as const : "default" as const,
      h: cardHeight({}),
      onClick: () => navigate({ view: "file", path: f.path }),
    })),
    ...view.outbound.slice(0, NEIGHBOURS).map((l) => ({
      id: `area:${l.to}`, lane: "uses", title: l.to.split("/").pop()!, sub: `${l.count} imports`, tone: "ghost" as const, icon: "area" as const, hue: hueFromPath(`${l.to}/x`),
      h: cardHeight({}), onClick: () => navigate({ view: "area", id: l.to }),
    })),
  ];
  const fileSet = new Set(files.map((f) => f.path));
  const links = [
    ...view.links.filter((l) => fileSet.has(l.from) && fileSet.has(l.to)).map((l, i) => ({ id: `l${i}`, from: l.from, to: l.to })),
    ...view.inbound.slice(0, NEIGHBOURS).map((l, i) => ({ id: `in${i}`, from: `area:${l.from}`, to: mostUsed(view, fileSet) })),
    ...view.outbound.slice(0, NEIGHBOURS).map((l, i) => ({ id: `out${i}`, from: leastUsed(view, fileSet), to: `area:${l.to}` })),
  ].filter((l) => l.from && l.to && l.from !== l.to);
  return Promise.resolve(lanes(specs, links, { maxPerRow: 4, first: ["used by"], last: ["uses"] }));
}

const mostUsed = (v: AreaView, set: Set<string>) => [...v.files].filter((f) => set.has(f.path)).sort((a, b) => b.importers - a.importers)[0]?.path ?? "";
const leastUsed = (v: AreaView, set: Set<string>) => [...v.files].filter((f) => set.has(f.path)).sort((a, b) => a.importers - b.importers)[0]?.path ?? "";

export function AreaInspector({ id }: { id: string }) {
  const { data } = useArea(id);
  if (!data) return null;
  const { area } = data;
  const unused = data.files.filter((f) => f.unreferenced);
  return (
    <>
      <div className="i-head">
        <div className="kick">Area{area.group ? ` · ${area.group}` : ""}</div>
        <div className="i-title">{area.label}</div>
        <div className="i-sub">{area.path}</div>
        <div className="i-meta"><span>{area.files} files</span><span>{area.functions} functions</span><span>{area.tests} tests</span></div>
        <div className="i-note">
          Areas come from the folder layout. Real features replace them once Docent has read the code.
        </div>
      </div>
      <Group title="Files" count={data.files.length} open>
        {data.files.map((f) => (
          <button key={f.path} className="row" onClick={() => navigate({ view: "file", path: f.path })}>
            <span className="grow mono">{f.path.slice(area.path.length + 1)}</span>
            <span className="sub">{f.unreferenced ? "unused?" : f.importers ? `used by ${f.importers}` : ""}</span>
          </button>
        ))}
      </Group>
      <Group title="Used by" count={data.inbound.length}>
        {data.inbound.map((l) => (
          <button key={l.from} className="row" onClick={() => navigate({ view: "area", id: l.from })}>
            <span className="grow">{l.from}</span><span className="sub">{l.count} imports</span>
          </button>
        ))}
      </Group>
      <Group title="Uses" count={data.outbound.length}>
        {data.outbound.map((l) => (
          <button key={l.to} className="row" onClick={() => navigate({ view: "area", id: l.to })}>
            <span className="grow">{l.to}</span><span className="sub">{l.count} imports</span>
          </button>
        ))}
      </Group>
      {unused.length > 0 && (
        <Group title="Possibly unused" count={unused.length}>
          {unused.map((f) => <button key={f.path} className="row" onClick={() => navigate({ view: "file", path: f.path })}><span className="grow">{f.path}</span></button>)}
        </Group>
      )}
    </>
  );
}
