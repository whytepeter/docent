import { memo } from "react";
import { reducedMotion, TRAVEL_S as TRAVEL } from "./motion.ts";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";

export type FlowEdgeData = {
  shape: "curve" | "step";
  /** Particles travel along the link to show which way it goes. */
  dots: boolean;
  label?: string;
  showLabel: boolean;
  /** Labeled packets that travel the link once, then rest at the far end. `key` restarts them. */
  packets?: { label: string; back: boolean; bad: boolean; delay: number; cycle: number }[];
  packetKey?: number;
  /** The scene is paused: packets rest where they land and particles stop. */
  paused?: boolean;
};
export type FlowEdgeType = Edge<FlowEdgeData, "flow">;

/**
 * A connector that reads like a drawn line: rounded orthogonal steps for flows, soft curves for maps,
 * with small particles moving in the direction of the call.
 */
export const FlowEdge = memo(function FlowEdge(props: EdgeProps<FlowEdgeType>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data } = props;
  const args = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
  const [path, labelX, labelY] = data?.shape === "step"
    ? getSmoothStepPath({ ...args, borderRadius: 18, offset: 28 })
    : getBezierPath({ ...args, curvature: 0.32 });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={18} />
      {data?.dots && !data.paused && (
        <g className="flow-dots" aria-hidden="true">
          {[0, 1].map((i) => (
            <circle key={i} r={2.6}>
              <animateMotion dur="2.6s" begin={`${i * 1.3}s`} repeatCount="indefinite" path={path} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.45 0 0.55 1" />
            </circle>
          ))}
        </g>
      )}
      {data?.packets?.map((p, i) => {
        const w = Math.max(48, p.label.length * 7.4 + 22);
        // One loop of the whole step: wait for its turn, travel, fade, wait for the others. Reduced motion: rest at the far end.
        const still = reducedMotion() || !!data.paused;
        const t0 = p.delay / p.cycle;
        const t1 = Math.min(0.97, (p.delay + TRAVEL) / p.cycle);
        const there = p.back ? "0" : "1";
        const from = p.back ? "1" : "0";
        return (
          <g key={`${data.packetKey}:${i}:${data.paused ? "p" : "r"}`} className={`packet${p.bad ? " bad" : ""}`} aria-hidden="true" opacity={still ? 1 : 0}>
            <rect x={-w / 2} y={-12} width={w} height={24} rx={12} />
            <text textAnchor="middle" dy="0.35em">{p.label}</text>
            {still ? (
              <animateMotion dur="0.01s" fill="freeze" path={path} keyPoints={`${there};${there}`} keyTimes="0;1" calcMode="linear" />
            ) : (
              <>
                <animateMotion dur={`${p.cycle}s`} repeatCount="indefinite" path={path} keyPoints={`${from};${from};${there};${there}`} keyTimes={`0;${t0};${t1};1`} calcMode="spline" keySplines="0 0 1 1;0.45 0 0.3 1;0 0 1 1" />
                <animate attributeName="opacity" dur={`${p.cycle}s`} repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes={`0;${t0};${t0 + 0.02};${t1 - 0.03};${t1};1`} />
              </>
            )}
          </g>
        );
      })}
      {data?.label && data.showLabel && (
        <EdgeLabelRenderer>
          <div className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
