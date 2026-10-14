import { useEffect } from "react";
import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { cardHeight, columns, Diagram, hueFromPath } from "../../shared/graph/index.ts";
import { headerStore } from "../../shared/state/header.ts";
import { revealGroup } from "../../shared/state/inspector.ts";
import { navigate } from "../../shared/state/router.ts";
import { Commits, Group, shortPath } from "../../shared/ui/index.ts";
import { openCode } from "../code/index.ts";
import { PartOf } from "../feature-view/index.ts";

const MAX_SIDE = 10;
const MAX_ROWS = 14;
const useFile = (path: string) => useQuery(`file:${path}`, () => api.file(path));

export function FileCanvas({ path }: { path: string }) {
  const { data, error } = useFile(path);

  useEffect(() => {
    if (!data) return;
    headerStore.set({
      title: path.split("/").pop()!,
      crumbs: data.area ? [{ label: data.area.label, route: { view: "area", id: data.area.id } }] : [],
    });
    document.title = `${path.split("/").pop()} · Docent`;
  }, [data, path]);

  if (error) return <div className="center-msg">{error.message}</div>;
  if (!data) return <div className="center-msg"><span className="spinner" /></div>;

  const importers = [...new Map(data.importers.map((i) => [i.file, i])).values()];
  const local = [...new Map(data.imports.filter((i) => i.file && i.kind !== "type").map((i) => [i.file!, i])).values()];
  const packages = [...new Set(data.imports.filter((i) => i.external).map((i) => i.external!))];

  const left = importers.length
    ? [...importers.slice(0, MAX_SIDE).map((i) => ({
        id: `in:${i.file}`, title: i.file.split("/").pop()!, sub: i.names.slice(0, 3).join(", ") || shortPath(i.file), mono: true, hue: hueFromPath(i.file), icon: "file" as const,
        onClick: () => navigate({ view: "file", path: i.file }),
      })), ...(importers.length > MAX_SIDE ? [{ id: "in:more", title: `${importers.length - MAX_SIDE} more`, tone: "ghost" as const, onClick: () => revealGroup("importers") }] : [])]
    : [{ id: "in:none", title: data.unreferenced ? "Nothing imports it" : "Entry point or test", tone: data.unreferenced ? "warn" as const : "ghost" as const }];
  const right = [
    ...local.slice(0, MAX_SIDE).map((i) => ({
      id: `out:${i.file}`, title: i.file!.split("/").pop()!, sub: i.names.slice(0, 3).join(", "), mono: true, hue: hueFromPath(i.file!), icon: "file" as const,
      onClick: () => navigate({ view: "file", path: i.file! }),
    })),
    ...(local.length > MAX_SIDE ? [{ id: "out:more", title: `${local.length - MAX_SIDE} more`, tone: "ghost" as const, onClick: () => revealGroup("imports") }] : []),
    ...(packages.length ? [{ id: "out:pkgs", title: `${packages.length} package${packages.length > 1 ? "s" : ""}`, sub: packages.slice(0, 3).join(", "), tone: "ghost" as const, icon: "folder" as const, onClick: () => revealGroup("imports") }] : []),
  ];
  const shown = data.symbols.slice(0, MAX_ROWS);
  const rows = [
    ...shown.map((s) => ({ id: s.id, label: s.name, sub: s.kind === "component" ? "component" : s.kind === "const" ? "value" : `L${s.line}`,
      onClick: () => (s.kind === "const" ? openCode(path, s.line) : navigate({ view: "fn", id: s.id })) })),
    ...(data.symbols.length > MAX_ROWS ? [{ id: "more", label: `${data.symbols.length - MAX_ROWS} more`, onClick: () => revealGroup("symbols") }] : []),
  ];
  const center = {
    id: "center", kicker: data.file.kind === "test" ? "test file" : "file", title: path.split("/").pop()!, sub: `${data.file.lines} lines`,
    tone: "focus" as const, mono: true, icon: "file" as const, w: 290, h: cardHeight({ kicker: true, rows: rows.length }), rows,
    onClick: () => openCode(path),
  };
  const { nodes, edges, sections } = columns(left, center, right.length ? right : [{ id: "out:none", title: "Imports nothing", tone: "ghost" as const }], {
    leftLabel: "Imported by",
    rightLabel: "Imports",
  });
  return <Diagram nodes={nodes} edges={edges} sections={sections} edgeShape="step" flowing label={`${path}: imported by ${importers.length} files, imports ${local.length}`} />;
}

export function FileInspector({ path }: { path: string }) {
  const { data } = useFile(path);
  if (!data) return null;
  return (
    <>
      <div className="i-head">
        <div className="kick">{data.file.kind === "test" ? "Test file" : "File"}</div>
        <div className="i-title mono">{path.split("/").pop()}</div>
        <div className="i-sub">{path}</div>
        <div className="i-meta">
          {data.area && <button className="link" onClick={() => navigate({ view: "area", id: data.area!.id })}>{data.area.label}</button>}
          <span>{data.file.lines} lines</span>
          <button className="link" onClick={() => openCode(path)}>Open file</button>
        </div>
        {data.unreferenced && <div className="i-note warn">No file imports this and it isn’t an entry point. It may be unused.</div>}
      </div>
      <PartOf file={path} />
      <Group id="symbols" title="Inside it" count={data.symbols.length} open>
        {data.symbols.map((s) => (
          <button key={s.id} className="row" onClick={() => (s.kind === "const" ? openCode(path, s.line) : navigate({ view: "fn", id: s.id }))}>
            <span className="grow mono">{s.name}</span><span className="sub">{s.kind === "const" ? "value" : s.kind} · L{s.line}</span>
          </button>
        ))}
      </Group>
      <Group id="importers" title="Imported by" count={data.importers.length}>
        {data.importers.map((i) => (
          <button key={`${i.file}:${i.line}`} className="row" onClick={() => navigate({ view: "file", path: i.file })}>
            <span className="grow">{shortPath(i.file, 3)}</span><span className="sub">{i.names.slice(0, 2).join(", ")}</span>
          </button>
        ))}
      </Group>
      <Group id="imports" title="Imports" count={data.imports.length}>
        {data.imports.map((i) => (
          <button key={`${i.line}:${i.file ?? i.external}`} className="row" onClick={() => (i.file ? navigate({ view: "file", path: i.file }) : openCode(path, i.line))}>
            <span className="grow">{i.file ? shortPath(i.file, 3) : i.external ?? "unresolved"}</span><span className="sub">{i.kind === "type" ? "types" : i.external ? "package" : `L${i.line}`}</span>
          </button>
        ))}
      </Group>
      <Group title="Tests" count={data.tests.length}>
        {data.tests.map((t) => (
          <button key={t.id} className="row" onClick={() => openCode(t.file, t.line)}>
            <span className="grow">{t.name}</span><span className="sub">{shortPath(t.file, 1)}:{t.line}</span>
          </button>
        ))}
      </Group>
      <Group title="Docs that name it" count={data.mentions.length}>
        {data.mentions.map((m) => (
          <button key={`${m.doc}:${m.line}`} className="row" onClick={() => openCode(m.doc, m.line)}>
            <span className="grow">{m.doc}</span><span className="sub">L{m.line}</span>
          </button>
        ))}
      </Group>
      <Group title="History" count={data.history.length}><Commits commits={data.history} /></Group>
      <Group title="Usually changes with" count={data.cochange.length}>
        {data.cochange.map((c) => (
          <button key={c.file} className="row" onClick={() => navigate({ view: "file", path: c.file })}>
            <span className="grow">{shortPath(c.file, 3)}</span><span className="sub">×{c.count}</span>
          </button>
        ))}
      </Group>
    </>
  );
}
