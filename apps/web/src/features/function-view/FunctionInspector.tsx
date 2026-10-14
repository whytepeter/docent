import type { Link } from "@docent/contracts";
import { navigate } from "../../shared/state/router.ts";
import { Commits, Group, shortPath } from "../../shared/ui/index.ts";
import { CodeView, openCode } from "../code/index.ts";
import { EvidenceDot } from "../evidence/index.ts";
import { PartOf } from "../feature-view/index.ts";
import { useSymbol } from "./FunctionCanvas.tsx";

const MAX_EXCERPT = 80;

function LinkRows({ links, side }: { links: Link[]; side: "in" | "out" }) {
  return (
    <>
      {links.map((l) => {
        const known = l.symbol.kind !== "unknown" && !l.symbol.id.includes("#test:");
        return (
          <button
            key={`${l.symbol.id}:${l.file}:${l.kind}`}
            className="row"
            onClick={() => (known ? navigate({ view: "fn", id: l.symbol.id }) : openCode(l.file, l.lines[0]))}
          >
            <EvidenceDot confidence={l.confidence} via={l.via} />
            <span className="grow mono">{l.kind === "constructs" ? "new " : l.kind === "renders" ? "<" : ""}{l.symbol.label}</span>
            <span className="sub">{side === "in" ? `${shortPath(l.file)}:${l.lines[0]}` : `L${l.lines.join(", ")}`}</span>
          </button>
        );
      })}
    </>
  );
}

export function FunctionInspector({ id }: { id: string }) {
  const { data } = useSymbol(id);
  if (!data) return null;
  const { symbol } = data;
  const lastLine = Math.min(symbol.end, symbol.line + MAX_EXCERPT - 1);
  return (
    <>
      <div className="i-head">
        <div className="kick">{symbol.kind === "component" ? "Component" : symbol.kind === "method" ? "Method" : "Function"}</div>
        <div className="i-title mono">{symbol.name}()</div>
        <div className="i-sub">{symbol.file}:{symbol.line}–{symbol.end}</div>
        <div className="i-meta">
          {data.area && <button className="link" onClick={() => navigate({ view: "area", id: data.area!.id })}>{data.area.label}</button>}
          <span>{symbol.exported ? "exported" : "not exported"}</span>
          <span>{symbol.end - symbol.line + 1} lines</span>
        </div>
      </div>
      <div className="i-code" data-scroll>
        <CodeView path={symbol.file} from={symbol.line} to={lastLine} />
      </div>
      <div className="i-actions">
        <button className="link" onClick={() => openCode(symbol.file, symbol.line, symbol.end)}>Open whole file</button>
        {symbol.end > lastLine && <span className="empty">showing the first {MAX_EXCERPT} lines</span>}
      </div>
      <PartOf file={symbol.file} symbol={symbol.id} />
      <Group id="callers" title="Called by" count={data.callers.length}><LinkRows links={data.callers} side="in" /></Group>
      <Group id="callees" title="Calls" count={data.callees.length}><LinkRows links={data.callees} side="out" /></Group>
      {data.children.length > 0 && (
        <Group id="children" title="Inside it" count={data.children.length}>
          {data.children.map((c) => (
            <button key={c.id} className="row" onClick={() => navigate({ view: "fn", id: c.id })}>
              <span className="grow mono">{c.name}</span><span className="sub">L{c.line}</span>
            </button>
          ))}
        </Group>
      )}
      <Group id="tests" title="Tests" count={data.tests.length}>
        {data.tests.map((t) => (
          <button key={t.id} className="row" onClick={() => openCode(t.file, t.line)}>
            <EvidenceDot confidence="confirmed" via={t.hops ? "reaches it through a helper" : "calls it directly"} />
            <span className="grow">{t.name}</span>
            <span className="sub">{shortPath(t.file, 1)}:{t.line}</span>
          </button>
        ))}
      </Group>
      <Group title="Docs that name it" count={data.mentions.length}>
        {data.mentions.map((m) => (
          <button key={`${m.doc}:${m.line}`} className="row" onClick={() => openCode(m.doc, m.line)}>
            <span className="grow">{m.doc}</span><span className="sub">{m.kind === "agent" ? "agent · " : ""}L{m.line}</span>
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
