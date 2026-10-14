import ELK from "elkjs/lib/elk.bundled.js";
import type { DiagramEdge, DiagramNode, DiagramSection, Hue } from "./types.ts";

export const NODE_W = 220;
export const NODE_H = 64;
export const ROW_H = 27;

/** Height of a card as rendered by CardNode, so layouts can stack boxes without overlap. */
export const cardHeight = ({ kicker, sub = true, rows = 0 }: { kicker?: boolean; sub?: boolean; rows?: number }) =>
  24 + (kicker ? 16 : 0) + 20 + (sub ? 17 : 0) + (rows ? 19 + rows * ROW_H : 0);

type Spec = Omit<DiagramNode, "x" | "y" | "w" | "h"> & { w?: number; h?: number; edgeLabel?: string };

/** A frame around a set of boxes, FigJam-section style: room for a label on top, a margin around. */
const SECTION_PAD = 18;
const SECTION_HEAD = 34;
function frame(id: string, label: string, hue: Hue | undefined, nodes: DiagramNode[], count?: number): DiagramSection | null {
  if (!nodes.length) return null;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  return {
    id, label, hue, count,
    x: minX - SECTION_PAD, y: minY - SECTION_PAD - SECTION_HEAD,
    w: maxX - minX + SECTION_PAD * 2, h: maxY - minY + SECTION_PAD * 2 + SECTION_HEAD,
  };
}

/**
 * Three columns: what points in ← the subject → what it points to.
 * The shape of the function and file views. Each side sits in its own labeled frame.
 */
export function columns(
  left: Spec[],
  center: Spec,
  right: Spec[],
  opts: { edgeTone?: (id: string) => DiagramEdge["tone"]; leftLabel?: string; rightLabel?: string } = {},
): { nodes: DiagramNode[]; edges: DiagramEdge[]; sections: DiagramSection[] } {
  const edgeTone = opts.edgeTone ?? (() => "default");
  const colW = NODE_W;
  const gap = 150;
  const rowGap = 14;
  const heightOf = (s: Spec) => s.h ?? NODE_H;
  const stackH = (xs: Spec[]) => xs.reduce((h, s) => h + heightOf(s), 0) + Math.max(0, xs.length - 1) * rowGap;
  const centerW = center.w ?? 250;
  const centerH = heightOf(center);
  const total = Math.max(stackH(left), stackH(right), centerH);
  const cx = colW + gap;
  const rx = cx + centerW + gap;

  const place = (xs: Spec[], x: number): DiagramNode[] => {
    let y = (total - stackH(xs)) / 2;
    return xs.map((s) => {
      const node = { ...s, x, y, w: s.w ?? colW, h: heightOf(s) };
      y += node.h + rowGap;
      return node;
    });
  };
  const leftNodes = place(left, 0);
  const rightNodes = place(right, rx);
  const centerNode: DiagramNode = { ...center, x: cx, y: (total - centerH) / 2, w: centerW, h: centerH };
  const edges: DiagramEdge[] = [
    ...leftNodes.filter((n) => n.tone !== "ghost" || n.onClick).map((n) => ({
      id: `${n.id}->c`, from: n.id, to: center.id, tone: edgeTone(n.id), label: (n as Spec).edgeLabel,
    })),
    ...rightNodes.filter((n) => n.tone !== "ghost" || n.onClick).map((n) => ({
      id: `c->${n.id}`, from: center.id, to: n.id, tone: edgeTone(n.id), label: (n as Spec).edgeLabel,
    })),
  ];
  const sections = [
    opts.leftLabel ? frame("sec:left", opts.leftLabel, undefined, leftNodes, left.filter((s) => s.tone !== "ghost").length) : null,
    opts.rightLabel ? frame("sec:right", opts.rightLabel, undefined, rightNodes, right.filter((s) => s.tone !== "ghost").length) : null,
  ].filter((s): s is DiagramSection => !!s);
  return { nodes: [...leftNodes, centerNode, ...rightNodes], edges, sections };
}

const elk = new ELK();

/** Layered layout for maps (files in an area), left to right in dependency order. */
export async function layered(
  specs: Spec[],
  links: { id: string; from: string; to: string; width?: number; tone?: DiagramEdge["tone"] }[],
): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[] }> {
  const graph = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.nodeNode": "22",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: specs.map((s) => ({ id: s.id, width: s.w ?? NODE_W, height: s.h ?? NODE_H })),
    edges: links.map((l) => ({ id: l.id, sources: [l.from], targets: [l.to] })),
  });
  const pos = new Map((graph.children ?? []).map((c) => [c.id, c]));
  const nodes = specs.map((s) => {
    const p = pos.get(s.id)!;
    return { ...s, x: p.x ?? 0, y: p.y ?? 0, w: p.width ?? NODE_W, h: p.height ?? NODE_H };
  });
  const edges: DiagramEdge[] = links.map((l) => ({ id: l.id, from: l.from, to: l.to, ...(l.width ? { width: l.width } : {}), ...(l.tone ? { tone: l.tone } : {}) }));
  return { nodes, edges };
}

/**
 * Lanes: one framed column per layer, ordered so dependencies point right (callers left, foundations right).
 * Used for the system map, where a free graph of every area is unreadable.
 */
export function lanes(
  specs: (Spec & { lane: string })[],
  links: { id: string; from: string; to: string; width?: number }[],
  { maxPerRow = 6, first = [], last = [], maxPerColumn = 7 }: { maxPerRow?: number; first?: string[]; last?: string[]; maxPerColumn?: number } = {},
): { nodes: DiagramNode[]; edges: DiagramEdge[]; sections: DiagramSection[] } {
  const laneOf = new Map(specs.map((s) => [s.id, s.lane]));
  const names = [...new Set(specs.map((s) => s.lane))];
  // Score each lane by how much it depends on others vs. is depended on.
  const score = new Map(names.map((n) => [n, 0]));
  for (const l of links) {
    const a = laneOf.get(l.from)!;
    const b = laneOf.get(l.to)!;
    if (a === b) continue;
    score.set(a, score.get(a)! - 1);
    score.set(b, score.get(b)! + 1);
  }
  const rank = (n: string) => (first.includes(n) ? -1e6 : last.includes(n) ? 1e6 : score.get(n)!);
  names.sort((a, b) => rank(a) - rank(b));
  const colW = 212;
  const gap = 72;
  const rowGap = 12;
  const nodes: DiagramNode[] = [];
  const sections: DiagramSection[] = [];
  // Wrap onto rows so a group with many folders stays a compact, readable block.
  const rowsOfLanes: string[][] = [];
  for (let i = 0; i < names.length; i += maxPerRow) rowsOfLanes.push(names.slice(i, i + maxPerRow));
  // A long lane splits into side-by-side columns inside its frame instead of one tall strip.
  const columnsOf = (name: string) => Math.ceil(specs.filter((sp) => sp.lane === name).length / maxPerColumn) || 1;
  const laneHeight = (name: string) => {
    const xs = specs.filter((sp) => sp.lane === name).slice(0, maxPerColumn);
    return xs.reduce((h, s) => h + (s.h ?? NODE_H), 0) + Math.max(0, xs.length - 1) * rowGap;
  };
  let rowTop = 0;
  const origin = new Map<string, { x: number; y: number }>();
  for (const row of rowsOfLanes) {
    let x = 0;
    for (const name of row) {
      origin.set(name, { x, y: rowTop });
      x += columnsOf(name) * (colW + 16) - 16 + gap;
    }
    rowTop += Math.max(...row.map(laneHeight)) + 96;
  }
  names.forEach((name) => {
    const { x: left, y: top } = origin.get(name)!;
    const laneNodes: DiagramNode[] = [];
    specs.filter((sp) => sp.lane === name).forEach((s, i) => {
      const col = Math.floor(i / maxPerColumn);
      const before = specs.filter((sp) => sp.lane === name).slice(col * maxPerColumn, i);
      const y = top + before.reduce((h, b) => h + (b.h ?? NODE_H) + rowGap, 0);
      laneNodes.push({ ...s, x: left + col * (colW + 16), y, w: s.w ?? colW, h: s.h ?? NODE_H });
    });
    nodes.push(...laneNodes);
    const section = frame(`sec:${name}`, name, laneNodes[0]?.hue, laneNodes, laneNodes.length);
    if (section) sections.push(section);
  });
  const edges: DiagramEdge[] = links.map((l) => ({ id: l.id, from: l.from, to: l.to, ...(l.width ? { width: l.width } : {}) }));
  return { nodes, edges, sections };
}

/** Layer of a file from its path (`src/features/...` → features), for the color tag on its box. */
export function hueFromPath(path: string): Hue {
  const m = /(?:^|\/)(app|features|components|shared)\//.exec(path);
  return (m?.[1] as Hue | undefined) ?? "other";
}
