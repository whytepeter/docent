import { useEffect, useMemo } from "react";
import type { FeatureAnalysis, FeatureDetail } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { startVerify, useFeatures } from "../../shared/api/features.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { cardHeight, Diagram, hueFromPath, type DiagramEdge, type DiagramNode, type DiagramSection } from "../../shared/graph/index.ts";
import { headerStore } from "../../shared/state/header.ts";
import { navigate } from "../../shared/state/router.ts";
import { Group, Icon, shortPath } from "../../shared/ui/index.ts";
import { openCode } from "../code/index.ts";
import "./feature.css";

export const useFeature = (id: string) => {
  const state = useFeatures();
  // Refetch when a job finishes (the shared store invalidates queries).
  return useQuery(`feature:${id}:${state?.cards.find((c) => c.feature.id === id)?.analysis?.claims ?? "none"}`, () => api.feature(id));
};

const STEP_W = 380;
const STEP_GAP = 56;

/** The feature's main path as a storyboard: one card per step, read top to bottom, particles showing the way. */
function storyboard(d: FeatureDetail): { nodes: DiagramNode[]; edges: DiagramEdge[]; sections: DiagramSection[] } {
  const steps = d.analysis?.flow ?? [];
  let y = 0;
  const nodes: DiagramNode[] = steps.map((s, i) => {
    const h = cardHeight({ kicker: true }) + 18;
    const node: DiagramNode = {
      id: `step:${i}`, x: 0, y, w: STEP_W, h,
      kicker: `Step ${i + 1}`,
      title: s.step,
      wrapTitle: true,
      sub: `${shortPath(s.file, 2)} · ${s.start}–${s.end}`,
      icon: "fn",
      hue: hueFromPath(s.file),
      tone: s.check.ok ? "default" : "warn",
      onClick: s.symbol ? () => navigate({ view: "fn", id: s.symbol }) : () => openCode(s.file, s.start, s.end),
    };
    y += h + STEP_GAP;
    return node;
  });
  const edges: DiagramEdge[] = nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: nodes[i]!.id, to: n.id, vertical: true }));
  const sections: DiagramSection[] = nodes.length
    ? [{ id: "sec:flow", label: "How it works, step by step", count: nodes.length, hue: nodes[0]!.hue, x: -20, y: -54, w: STEP_W + 40, h: y - STEP_GAP + 74 }]
    : [];
  return { nodes, edges, sections };
}

export function FeatureCanvas({ id }: { id: string }) {
  const { data, error } = useFeature(id);
  const state = useFeatures();
  const running = !!state?.job && !state.job.finishedAt;

  useEffect(() => {
    if (!data) return;
    headerStore.set({ title: data.feature.name, crumbs: [{ label: "Overview", route: { view: "system" } }] });
    document.title = `${data.feature.name} · Docent`;
  }, [data]);

  const graph = useMemo(() => (data?.analysis ? storyboard(data) : null), [data]);

  if (error) return <div className="center-msg">{error.message}</div>;
  if (!data) return <div className="center-msg"><span className="spinner" /></div>;
  if (!graph || !graph.nodes.length) {
    return (
      <div className="center-msg feature-empty">
        <div>
          <h2>{data.feature.name}</h2>
          <p>{data.feature.summary}</p>
          <p className="muted">Not checked yet. Docent traces it end to end and checks every claim against the code; watching its episode does this first.</p>
          <button className="primary-btn" disabled={running} onClick={() => void startVerify(id)}>{running ? "Verifying…" : "Verify this feature"}</button>
        </div>
      </div>
    );
  }
  return <Diagram nodes={graph.nodes} edges={graph.edges} sections={graph.sections} edgeShape="step" flowing readableZoom={0.85} label={`${data.feature.name}, step by step`} />;
}

const LABEL_TEXT: Record<string, string> = {
  confirmed: "Confirmed · read in the code, citation checked, and a second reader couldn't refute it",
  inferred: "Inferred · a reasoned guess",
  unknown: "Unknown",
  record: "Record · from commit history",
};

function Claims({ claims }: { claims: FeatureAnalysis["claims"] }) {
  return (
    <>
      {claims.map((c, i) => (
        <div key={i} className="claim">
          <span className={`dot ${c.label === "record" ? "record" : c.label}`} title={c.review?.verdict === "upheld" ? `${LABEL_TEXT[c.label]}: ${c.review.reason}` : LABEL_TEXT[c.label]} />
          <div>
            <p>{c.text}</p>
            <div className="evidence">
              {c.evidence.map((e, j) => (
                <button key={j} className={`ev-chip${e.check.ok ? "" : " bad"}`} title={e.check.ok ? `${e.file}:${e.start}–${e.end}` : e.check.reason} onClick={() => openCode(e.file, e.start, e.end)}>
                  {shortPath(e.file, 1)}:{e.start}{e.end !== e.start ? `–${e.end}` : ""}
                </button>
              ))}
              {c.label === "record" && c.commit && <span className="ev-chip static">commit {c.commit.slice(0, 7)}</span>}
            </div>
            {c.checkNote && <p className="check-note">Claude said “{c.claimedLabel}”; {c.checkNote}.</p>}
          </div>
        </div>
      ))}
    </>
  );
}

export function FeatureInspector({ id }: { id: string }) {
  const { data } = useFeature(id);
  const state = useFeatures();
  const running = !!state?.job && !state.job.finishedAt;
  if (!data) return null;
  const { feature, analysis } = data;
  const by = (k: string) => analysis?.claims.filter((c) => c.kind === k) ?? [];
  return (
    <>
      <div className="i-head">
        <div className="kick">Feature · {feature.kind}</div>
        <div className="i-title">{feature.name}</div>
        <p className="feature-summary">{analysis?.summary ?? feature.summary}</p>
        {analysis && (
          <div className="i-meta">
            <span className={`status ${analysis.status}`}>{analysis.status}</span>
            <span>{analysis.claims.filter((c) => c.label === "confirmed").length} of {analysis.claims.length} claims confirmed</span>
            {data.stale && <span className="stale">code changed since</span>}
          </div>
        )}
      </div>
      <button className="watch" onClick={() => navigate({ view: "episode", id })}><Icon name="play" size={13} weight="bold" />Watch the episode</button>
      {analysis ? (
        <>
          <div className="analogy"><b>Think of it like this.</b> {analysis.analogy}</div>
          <p className="status-reason">{analysis.statusReason}</p>
          <Group title="What must stay true" count={by("invariant").length} open><Claims claims={by("invariant")} /></Group>
          <Group title="How it behaves" count={by("behavior").length}><Claims claims={by("behavior")} /></Group>
          <Group title="Why it's built this way" count={by("why").length}><Claims claims={by("why")} /></Group>
          <Group title="What could break" count={by("risk").length}><Claims claims={by("risk")} /></Group>
          {by("doc-mismatch").length > 0 && <Group title="Docs that disagree with the code" count={by("doc-mismatch").length} open><Claims claims={by("doc-mismatch")} /></Group>}
          <Group title="Issues" count={analysis.issues.length} open={analysis.issues.some((i) => i.severity === "high")}>
            {analysis.issues.map((iss, i) => (
              <div key={i} className="claim">
                <span className={`sev-dot ${iss.severity}`} title={`${iss.severity} severity`} />
                <div>
                  <p><b>{iss.title}.</b> {iss.detail}</p>
                  <div className="evidence">
                    {iss.evidence.map((e, j) => (
                      <button key={j} className={`ev-chip${e.check.ok ? "" : " bad"}`} title={e.check.reason} onClick={() => openCode(e.file, e.start, e.end)}>{shortPath(e.file, 1)}:{e.start}</button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </Group>
        </>
      ) : (
        <p className="feature-summary muted">Not checked yet. Watching the episode checks it first.</p>
      )}
      <Group title="Files" count={feature.files.length}>
        {feature.files.map((f) => (
          <button key={f} className="row" onClick={() => navigate({ view: "file", path: f })}>
            <span className="grow mono">{shortPath(f, 3)}</span>
          </button>
        ))}
      </Group>
      <div className="i-actions">
        <button className="link" disabled={running} onClick={() => void startVerify(id)}>{analysis ? (data.stale ? "Check again (code changed)" : "Check again") : "Check this feature"}</button>
        {analysis && <span className="empty">{analysis.model} · {analysis.generatedAt.slice(0, 10)}</span>}
      </div>
    </>
  );
}
