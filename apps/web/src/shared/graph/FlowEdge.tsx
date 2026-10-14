import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";

export type FlowEdgeData = {
  shape: "curve" | "step";
  /** Particles travel along the link to show which way it goes. */
  dots: boolean;
  label?: string;
  showLabel: boolean;
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
      {data?.dots && (
        <g className="flow-dots" aria-hidden="true">
          {[0, 1].map((i) => (
            <circle key={i} r={2.6}>
              <animateMotion dur="2.6s" begin={`${i * 1.3}s`} repeatCount="indefinite" path={path} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.45 0 0.55 1" />
            </circle>
          ))}
        </g>
      )}
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
