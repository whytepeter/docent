import { useEffect } from "react";
import type { Link, SymbolView } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { cardHeight, columns, Diagram, hueFromPath } from "../../shared/graph/index.ts";
import { headerStore } from "../../shared/state/header.ts";
import { revealGroup } from "../../shared/state/inspector.ts";
import { navigate } from "../../shared/state/router.ts";
import { shortPath } from "../../shared/ui/index.ts";
import { openCode } from "../code/index.ts";

const MAX_SIDE = 10;
const lineText = (lines: number[]) => `line${lines.length > 1 ? "s" : ""} ${lines.slice(0, 4).join(", ")}${lines.length > 4 ? "…" : ""}`;
const VERB = { calls: undefined, constructs: "creates", renders: "renders" } as const;

export function useSymbol(id: string) {
  return useQuery(`symbol:${id}`, () => api.symbol(id));
}

function linkSpec(link: Link, side: "in" | "out") {
  const known = link.symbol.kind !== "unknown";
  const isTest = link.symbol.id.includes("#test:");
  return {
    id: `${side}:${link.symbol.id}:${link.file}:${link.kind}`,
    title: link.symbol.label,
    kicker: side === "out" ? VERB[link.kind] : undefined,
    // For callers the lines are in their file; for callees, where the subject uses them.
    sub: side === "in" ? `${shortPath(link.file)} · ${lineText(link.lines)}` : shortPath(link.symbol.file),
    tone: (known && !isTest ? "default" : "ghost") as "default" | "ghost",
    edgeLabel: side === "in" ? `line ${link.lines[0]}` : `L${link.lines.slice(0, 3).join(", ")}`,
    h: cardHeight({ kicker: side === "out" && link.kind !== "calls" }),
    hue: known && !isTest ? hueFromPath(link.symbol.file) : undefined,
    icon: known && !isTest ? (link.symbol.kind === "component" ? "component" as const : "fn" as const) : undefined,
    mono: true,
    onClick: known && !isTest ? () => navigate({ view: "fn", id: link.symbol.id }) : () => openCode(link.file, link.lines[0]),
  };
}

function overflow(links: Link[], side: "in" | "out") {
  if (links.length <= MAX_SIDE) return [];
  return [{
    id: `${side}:more`, title: `${links.length - MAX_SIDE} more`, tone: "ghost" as const,
    onClick: () => revealGroup(side === "in" ? "callers" : "callees"),
  }];
}

export function FunctionCanvas({ id }: { id: string }) {
  const { data, error } = useSymbol(id);

  useEffect(() => {
    if (!data) return;
    const crumbs = [
      ...(data.area ? [{ label: data.area.label, route: { view: "area" as const, id: data.area.id } }] : []),
      { label: data.symbol.file.split("/").pop()!, route: { view: "file" as const, path: data.symbol.file } },
      ...(data.parent ? [{ label: data.parent.name, route: { view: "fn" as const, id: data.parent.id } }] : []),
    ];
    headerStore.set({ title: `${data.symbol.name}()`, crumbs });
    document.title = `${data.symbol.name} · Docent`;
  }, [data]);

  if (error) return <div className="center-msg">{error.message}</div>;
  if (!data) return <div className="center-msg"><span className="spinner" /></div>;
  return <FunctionDiagram view={data} />;
}

function FunctionDiagram({ view }: { view: SymbolView }) {
  const { symbol, callers, callees, children, tests } = view;
  const left = callers.length
    ? [...callers.slice(0, MAX_SIDE).map((l) => linkSpec(l, "in")), ...overflow(callers, "in")]
    : [{ id: "in:none", title: tests.length ? "Only tests call it" : "Nothing calls it", tone: "ghost" as const }];
  const right = callees.length
    ? [...callees.slice(0, MAX_SIDE).map((l) => linkSpec(l, "out")), ...overflow(callees, "out")]
    : [{ id: "out:none", title: "Calls nothing in the repo", tone: "ghost" as const }];

  const rows = [
    ...children.slice(0, 6).map((c) => ({ id: c.id, label: c.name, sub: "inside", onClick: () => navigate({ view: "fn", id: c.id }) })),
    ...(children.length > 6 ? [{ id: "kids:more", label: `${children.length - 6} more inside`, onClick: () => revealGroup("children") }] : []),
    { id: "tests", label: tests.length ? `${tests.length} test${tests.length > 1 ? "s" : ""}` : "No tests reach it", sub: tests.length ? "show" : "", onClick: () => revealGroup("tests") },
  ];
  const center = {
    id: "center",
    kicker: symbol.kind === "component" ? "component" : symbol.kind === "method" ? "method" : "function",
    title: `${symbol.name}()`,
    sub: `${shortPath(symbol.file)} · ${symbol.line}–${symbol.end}`,
    tone: "focus" as const,
    mono: true,
    icon: symbol.kind === "component" ? "component" as const : "fn" as const,
    w: 290,
    h: cardHeight({ kicker: true, rows: rows.length }),
    rows,
    onClick: () => openCode(symbol.file, symbol.line, symbol.end),
  };
  const tone = new Map([...callers, ...callees].map((l) => [l.symbol.id, l.confidence]));
  const { nodes, edges, sections } = columns(left, center, right, {
    edgeTone: (nodeId) => (tone.get(nodeId.split(":").slice(1, -2).join(":")) === "inferred" ? "inferred" : "default"),
    leftLabel: "Called by",
    rightLabel: "Calls",
  });
  return (
    <Diagram
      nodes={nodes}
      edges={edges}
      sections={sections}
      edgeShape="step"
      flowing
      edgeLabels
      label={`${symbol.name}: ${callers.length} callers, ${callees.length} callees`}
    />
  );
}
