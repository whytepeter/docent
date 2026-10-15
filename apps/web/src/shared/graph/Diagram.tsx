import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, Controls, MarkerType, ReactFlow, ReactFlowProvider, getViewportForBounds, useReactFlow,
  type Node, type NodeMouseHandler,
} from "@xyflow/react";
import { CardNode, DiveContext, SectionNode, type CardNodeType, type SectionNodeType } from "./CardNode.tsx";
import { FlowEdge, type FlowEdgeType } from "./FlowEdge.tsx";
import { easeInOutCubic, easeOutQuint, PACKET_GAP_S as PACKET_GAP, PACKET_LEAD_S, reducedMotion, TRAVEL_S } from "./motion.ts";
import type { DiagramEdge, DiagramNode, DiagramSection } from "./types.ts";
import { insets, inspectorVisible, inspectorWidth, sidebarStore } from "../state/chrome.ts";
import { entryDirection } from "../state/router.ts";
import { canvasStore, sceneStore } from "../state/scene.ts";
import { useStore } from "../state/store.ts";
import "./flow.css";

const nodeTypes = { card: CardNode, section: SectionNode };
const edgeTypes = { flow: FlowEdge };
const MAX_ZOOM = 1.15;
/** Room kept clear under a playing scene for its caption or play bar. */
const SCENE_BOTTOM = 190;

export interface DiagramProps {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  label: string;
  sections?: DiagramSection[];
  /** "step" for flows (function, file), "curve" for maps. */
  edgeShape?: "curve" | "step";
  /** Particles always flowing along every link (small graphs where direction is the lesson). */
  flowing?: boolean;
  /** Show link labels all the time instead of only on hover. */
  edgeLabels?: boolean;
  /** Hide links until a box is pointed at. For dense maps. */
  quietEdges?: boolean;
  /** Extra room to keep clear at the top, for a view's own floating header. */
  topSpace?: number;
  /** Never open below this zoom; a tall picture starts at its top and scrolls instead of shrinking. */
  readableZoom?: number;
  /** Clicking a box calls its handler straight away, without the zoom into it (players keep the camera). */
  noDive?: boolean;
}

/**
 * The canvas every view draws on (React Flow). Pan with the trackpad, pinch to zoom.
 * Pointing at a box lights up what it connects to; clicking dives into it, and the next view
 * arrives as a zoom, so moving through the codebase feels like one continuous canvas.
 */
export function Diagram(props: DiagramProps) {
  return (
    <ReactFlowProvider>
      <FlowInner {...props} />
    </ReactFlowProvider>
  );
}

function FlowInner({ nodes, edges, label, sections = [], edgeShape = "curve", flowing = false, edgeLabels = false, quietEdges = false, topSpace = 0, readableZoom = 0, noDive = false }: DiagramProps) {
  const [hover, setHover] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { setViewport, setCenter, getZoom, getNode } = useReactFlow();
  const sidebarOpen = useStore(sidebarStore);
  const inspectorOpen = useStore(inspectorVisible);
  const panelWidth = useStore(inspectorWidth);
  const inset = insets(sidebarOpen, inspectorOpen, panelWidth);
  const px = (n: number) => `${n}px` as const;
  const padding = { top: px(inset.top + topSpace), bottom: px(inset.bottom), left: px(inset.left), right: px(inset.right) };
  const paddingKey = JSON.stringify(padding);
  void padding;
  const [visible, setVisible] = useState(false);

  // First appearance: fit, then arrive with a short zoom in the direction of travel (deeper zooms in,
  // back up zooms out). Later: animate re-fits when the window resizes or a panel opens or closes.
  const settled = useRef(false);
  /** While a scene plays, where the camera should rest instead (framing its lit boxes). */
  const sceneFit = useRef<(() => { x: number; y: number; zoom: number }) | null>(null);
  const restAt = () => sceneFit.current?.() ?? target();
  /** Where the camera should rest: fit to the open space, unless that would make text too small. Computed, not queued. */
  const target = useCallback(() => {
    const el = box.current;
    const boxes = [...nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })), ...sections.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h }))];
    if (!el || !boxes.length) return { x: 0, y: 0, zoom: 1 };
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const pad = JSON.parse(paddingKey) as Record<"top" | "bottom" | "left" | "right", string>;
    const fit = getViewportForBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, el.clientWidth, el.clientHeight, 0.2, MAX_ZOOM, pad as never);
    if (!readableZoom || fit.zoom >= readableZoom) return fit;
    const z = readableZoom;
    const left = parseFloat(pad.left);
    const right = parseFloat(pad.right);
    const centerX = left + (el.clientWidth - left - right) / 2;
    return { x: centerX - ((minX + maxX) / 2) * z, y: parseFloat(pad.top) - minY * z, zoom: z };
  }, [paddingKey, readableZoom, nodes, sections]);

  /** First placement, once React Flow has the nodes: rest position, arriving with a short zoom in the direction of travel. */
  const place = useCallback(() => {
    if (settled.current) return;
    settled.current = true;
    const rest = target();
    const dir = entryDirection();
    const el = box.current;
    if (dir === "same" || reducedMotion() || !el) {
      setViewport(rest);
      setVisible(true);
      return;
    }
    const k = dir === "in" ? 0.82 : 1.22;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    setViewport({ x: cx - (cx - rest.x) * k, y: cy - (cy - rest.y) * k, zoom: rest.zoom * k });
    requestAnimationFrame(() => {
      setVisible(true);
      setViewport(rest, { duration: 620, ease: easeOutQuint, interpolate: "smooth" });
    });
  }, [target, setViewport]);

  // Later changes (window resize, a panel opening or closing) glide to the new rest position.
  useEffect(() => {
    if (!settled.current) return;
    const t = setTimeout(() => setViewport(restAt(), { duration: 420, ease: easeOutQuint, interpolate: "smooth" }), 30);
    return () => clearTimeout(t);
  }, [paddingKey, target, setViewport]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let rt: ReturnType<typeof setTimeout> | undefined;
    let initial = true;
    const ro = new ResizeObserver(() => {
      if (initial) return void (initial = false);
      if (!settled.current) return;
      clearTimeout(rt);
      rt = setTimeout(() => setViewport(restAt(), { duration: 420, ease: easeOutQuint, interpolate: "smooth" }), 60);
    });
    ro.observe(el);
    return () => {
      clearTimeout(rt);
      ro.disconnect();
    };
  }, [target, setViewport]);

  /** Glide into a box, then move on. The next view picks up the motion as it arrives. */
  const dive = useCallback((nodeId: string, then: () => void) => {
    const n = getNode(nodeId);
    if (!n || reducedMotion()) return then();
    const w = n.width ?? n.measured?.width ?? 200;
    const h = n.height ?? n.measured?.height ?? 60;
    setLeaving(true);
    setCenter(n.position.x + w / 2, n.position.y + Math.min(h, 90) / 2, { zoom: Math.min(getZoom() * 1.8, 2.2), duration: 380, ease: easeInOutCubic, interpolate: "smooth" });
    setTimeout(then, 250);
  }, [getNode, getZoom, setCenter]);

  // Tell the rest of the app what's on screen, so a question can point at these boxes.
  useEffect(() => {
    canvasStore.set({
      boxes: nodes.filter((n) => n.tone !== "ghost").map((n) => ({ id: n.id, title: n.title, ...(n.sub ?? n.kicker ? { sub: n.sub ?? n.kicker } : {}) })),
      links: edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) })),
    });
    return () => canvasStore.set({ boxes: [], links: [] });
  }, [nodes, edges]);

  // A playing scene lights its boxes and links, and the camera glides to them; stopping glides back.
  const scene = useStore(sceneStore);
  const step = scene?.steps[scene.index] ?? null;
  const sceneLit = useMemo(() => {
    if (!step) return null;
    const set = new Set(step.nodes);
    for (const e of step.edges) set.add(e.from).add(e.to);
    return set;
  }, [step]);
  const sceneEdges = useMemo(() => {
    if (!step || !sceneLit) return null;
    const explicit = new Set(step.edges.map((e) => `${e.from}>${e.to}`));
    return new Set(edges.filter((e) => explicit.has(`${e.from}>${e.to}`) || explicit.has(`${e.to}>${e.from}`) || (sceneLit.has(e.from) && sceneLit.has(e.to))).map((e) => e.id));
  }, [step, sceneLit, edges]);
  // Boxes new to this step get a one-time ring, so "what's new now" is visible.
  const prevLit = useRef<Set<string>>(new Set());
  const arrived = useMemo(() => {
    const prev = prevLit.current;
    return sceneLit ? new Set([...sceneLit].filter((id) => !prev.has(id))) : new Set<string>();
  }, [sceneLit]);
  useEffect(() => {
    prevLit.current = sceneLit ?? new Set();
  }, [sceneLit]);

  // Packets play one after another in the order the step lists them (the order things happen), then loop.
  const packetsOn = useMemo(() => {
    const out = new Map<string, { label: string; back: boolean; bad: boolean; delay: number; cycle: number }[]>();
    const all = step?.packets ?? [];
    const cycle = PACKET_LEAD_S + PACKET_GAP * all.length + 1.0;
    const lead = reducedMotion() ? 0 : PACKET_LEAD_S;
    all.forEach((p, i) => out.set(p.edge, [...(out.get(p.edge) ?? []), { label: p.label, back: p.back, bad: p.bad, delay: lead + i * PACKET_GAP, cycle }]));
    return out;
  }, [step]);
  // When a packet lands, the box it reaches reacts once (first pass only): cause and effect, visible.
  const [pulses, setPulses] = useState<Map<string, { n: number; bad: boolean }>>(new Map());
  useEffect(() => {
    // A new step starts clean: no ring left over from where the last one's data landed.
    setPulses((m) => (m.size ? new Map() : m));
    if (!step?.packets?.length || scene?.paused) return;
    const still = reducedMotion();
    const byId = new Map(edges.map((e) => [e.id, e]));
    const timers = step.packets.map((p, i) => {
      const edge = byId.get(p.edge);
      if (!edge) return undefined;
      const target = p.back ? edge.from : edge.to;
      const at = still ? i * 150 : (PACKET_LEAD_S + i * PACKET_GAP + TRAVEL_S) * 1000;
      return setTimeout(() => setPulses((m) => new Map(m).set(target, { n: (m.get(target)?.n ?? 0) + 1, bad: p.bad })), at);
    });
    return () => timers.forEach((t) => t && clearTimeout(t));
  }, [step, scene?.paused, edges]);

  const wasPlaying = useRef(false);
  useEffect(() => {
    const el = box.current;
    if (!settled.current || !el) return;
    if (!sceneLit) {
      sceneFit.current = null;
      if (wasPlaying.current) setViewport(target(), { duration: 520, ease: easeOutQuint, interpolate: "smooth" });
      wasPlaying.current = false;
      return;
    }
    wasPlaying.current = true;
    const lit = nodes.filter((n) => sceneLit.has(n.id));
    if (!lit.length) return;
    const minX = Math.min(...lit.map((n) => n.x));
    const minY = Math.min(...lit.map((n) => n.y));
    const maxX = Math.max(...lit.map((n) => n.x + n.w));
    const maxY = Math.max(...lit.map((n) => n.y + n.h));
    // Leave room at the bottom for the caption or play bar floating over the canvas.
    sceneFit.current = () => {
      const pad = JSON.parse(paddingKey) as Record<"top" | "bottom" | "left" | "right", string>;
      const framed = { ...pad, bottom: `${parseFloat(pad.bottom) + SCENE_BOTTOM}px` };
      return getViewportForBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, el.clientWidth, el.clientHeight, 0.3, 1.25, framed as never);
    };
    setViewport(sceneFit.current(), { duration: reducedMotion() ? 0 : 600, ease: easeInOutCubic, interpolate: "smooth" });
  }, [sceneLit, nodes, paddingKey, setViewport, target]);

  const linked = useMemo(() => {
    if (sceneLit) return sceneLit;
    if (!hover) return null;
    const set = new Set([hover]);
    for (const e of edges) if (e.from === hover || e.to === hover) set.add(e.from).add(e.to);
    return set;
  }, [hover, edges, sceneLit]);

  const rfNodes = useMemo<Node[]>(() => [
    ...sections.map((s): SectionNodeType => ({
      id: s.id, type: "section", position: { x: s.x, y: s.y }, width: s.w, height: s.h, zIndex: -1,
      data: { label: s.label, hue: s.hue, count: s.count, w: s.w, h: s.h, dim: false },
      selectable: false, draggable: false, focusable: false,
    })),
    ...nodes.map((n): CardNodeType => ({
      id: n.id,
      type: "card",
      position: { x: n.x, y: n.y },
      width: n.w,
      height: n.h,
      data: { ...n, lit: !!linked?.has(n.id) && (linked.size > 1 || !!sceneLit), dim: !!linked && !linked.has(n.id), scene: !!sceneLit, arrive: arrived.has(n.id), pulse: pulses.get(n.id) },
      draggable: false,
      selectable: false,
      focusable: !!n.onClick,
      ariaLabel: n.title,
    })),
  ], [nodes, sections, linked, sceneLit, arrived, pulses]);

  const rfEdges = useMemo<FlowEdgeType[]>(() => edges.map((e) => {
    const on = sceneEdges ? sceneEdges.has(e.id) : !!hover && (e.from === hover || e.to === hover);
    const quiet = sceneEdges ? !on : !!hover && !on;
    const color = on ? "var(--accent)" : e.tone === "inferred" ? "var(--amber-dot)" : "var(--edge-strong)";
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      ...(e.vertical ? { sourceHandle: "b", targetHandle: "t" } : {}),
      type: "flow",
      // A link carrying packets draws above the boxes, so its chips are never covered.
      ...(packetsOn.get(e.id) ? { zIndex: 1000 } : {}),
      hidden: quietEdges && !on,
      className: `flow-edge${e.tone === "inferred" ? " inferred" : ""}${on ? " on" : ""}${quiet ? " faded" : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color },
      style: e.width ? { strokeWidth: e.width } : undefined,
      data: {
        shape: edgeShape, dots: (flowing || on) && !packetsOn.get(e.id), label: e.label, showLabel: (edgeLabels || on) && !packetsOn.get(e.id),
        ...(packetsOn.get(e.id) ? { packets: packetsOn.get(e.id), packetKey: scene?.index ?? 0 } : {}),
        paused: !!scene?.paused,
      },
      focusable: false,
    };
  }), [edges, hover, sceneEdges, packetsOn, scene?.index, scene?.paused, quietEdges, edgeShape, flowing, edgeLabels]);

  const onEnter: NodeMouseHandler = useCallback((_, n) => n.type === "card" && setHover(n.id), []);
  const onLeave: NodeMouseHandler = useCallback(() => setHover(null), []);
  const onClick: NodeMouseHandler = useCallback((_, n) => {
    const data = n.data as unknown as CardNodeType["data"];
    if (n.type === "card" && data.onClick) (noDive ? data.onClick() : dive(n.id, data.onClick));
  }, [dive, noDive]);

  return (
    <DiveContext.Provider value={dive}>
      <div ref={box} className={`flow${visible ? " visible" : ""}${leaving ? " leaving" : ""}`} aria-label={label} role="figure">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeMouseEnter={onEnter}
          onNodeMouseLeave={onLeave}
          onNodeClick={onClick}
          onInit={place}
          minZoom={0.2}
          maxZoom={2.5}
          panOnScroll
          zoomOnPinch
          zoomOnDoubleClick={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          colorMode="system"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.1} color="var(--grid)" />
          <Controls showInteractive={false} position="bottom-center" orientation="horizontal" />
        </ReactFlow>
      </div>
    </DiveContext.Provider>
  );
}
