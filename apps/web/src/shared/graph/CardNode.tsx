import { createContext, memo, useContext } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { CheckCircle, Cube, FileCode, Folder, Function as FnIcon, ArrowBendDownLeft, SquaresFour, TextAlignLeft } from "@phosphor-icons/react";
import type { DiagramNode } from "./types.ts";

const KIND_ICON = { area: SquaresFour, file: FileCode, fn: FnIcon, component: Cube, folder: Folder };
const META_ICON = { file: FileCode, fn: FnIcon, test: CheckCircle, used: ArrowBendDownLeft, lines: TextAlignLeft };

export type CardData = DiagramNode & { lit: boolean; dim: boolean };

/** Lets a row inside a box ask the canvas to dive into that box before moving on. */
export const DiveContext = createContext<(nodeId: string, then: () => void) => void>((_, then) => then());
export type CardNodeType = Node<CardData, "card">;

/** One box on the canvas. Real HTML, so type, wrapping and focus behave like the rest of the app. */
export const CardNode = memo(function CardNode({ id, data }: NodeProps<CardNodeType>) {
  const clickable = !!data.onClick;
  const dive = useContext(DiveContext);
  return (
    <div
      className={`card-node tone-${data.tone ?? "default"}${clickable ? " clickable" : ""}${data.lit ? " lit" : ""}${data.dim ? " dim" : ""}`}
      style={{ width: data.w, minHeight: data.h }}
      data-hue={data.hue}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle id="t" type="target" position={Position.Top} isConnectable={false} />
      <div className="card-head">
        {data.icon && <KindChip icon={data.icon} />}
        <div className="card-text">
          {data.kicker && <div className="card-kicker">{data.kicker}</div>}
          <div className={`card-title${data.mono ? " mono" : ""}${data.wrapTitle ? " wrap" : ""}`} title={data.title}>{data.title}</div>
          {data.meta && data.meta.length > 0 ? (
            <div className="card-meta">
              {data.meta.map((m) => {
                const I = META_ICON[m.icon];
                return <span key={m.label} title={`${m.value} ${m.label}`}><I size={12} weight="regular" aria-hidden="true" />{m.value}<span className="sr">{` ${m.label}`}</span></span>;
              })}
            </div>
          ) : data.sub ? <div className="card-sub" title={data.sub}>{data.sub}</div> : null}
        </div>
      </div>
      {data.rows && data.rows.length > 0 && (
        <div className="card-rows">
          {data.rows.map((r) => (
            <button
              key={r.id}
              className="card-row nodrag"
              onClick={(e) => {
                e.stopPropagation();
                if (r.onClick) dive(id, r.onClick);
              }}
            >
              <span className="mono">{r.label}</span>
              {r.sub && <span className="card-row-sub">{r.sub}</span>}
            </button>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <Handle id="b" type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

function KindChip({ icon }: { icon: NonNullable<DiagramNode["icon"]> }) {
  const I = KIND_ICON[icon];
  return <span className="card-chip" aria-hidden="true"><I size={15} weight="duotone" /></span>;
}

export type SectionData = { label: string; hue?: string; count?: number; w: number; h: number; dim: boolean };
export type SectionNodeType = Node<SectionData, "section">;

/** A tinted frame behind a group of boxes, labeled like a FigJam section. */
export const SectionNode = memo(function SectionNode({ data }: NodeProps<SectionNodeType>) {
  return (
    <div className={`section-node${data.dim ? " dim" : ""}`} data-hue={data.hue} style={{ width: data.w, height: data.h }}>
      <div className="section-label">
        <i aria-hidden="true" />{data.label}
        {data.count !== undefined && <span>{data.count}</span>}
      </div>
    </div>
  );
});
