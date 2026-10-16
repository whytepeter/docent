import { useEffect, useMemo, useState } from "react";
import type { Feature } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { refreshFeatures, startPrepare, useFeatures } from "../../shared/api/features.ts";
import { Diagram } from "../../shared/graph/index.ts";
import { headerStore } from "../../shared/state/header.ts";
import { inspectorStore } from "../../shared/state/inspector.ts";
import { navigate } from "../../shared/state/router.ts";
import { useStore } from "../../shared/state/store.ts";
import { Group, shortPath } from "../../shared/ui/index.ts";
import { layoutFeatureLanes } from "../feature-map/index.ts";
import { reviewStore, updateDraft } from "./review-store.ts";
import "./review.css";

const KINDS: Feature["kind"][] = ["user-facing", "operator", "background", "shared"];

/** The proposed features on the canvas; click one to edit it in the panel. */
export function ReviewCanvas() {
  const state = useFeatures();
  const { draft, selected } = useStore(reviewStore);

  useEffect(() => {
    headerStore.set({ title: "Review the feature map", crumbs: [{ label: "Overview", route: { view: "system" } }] });
    if (state?.map && !reviewStore.get().draft) reviewStore.set({ draft: structuredClone(state.map.features), selected: null, dirty: false });
  }, [state?.map]);

  const graph = useMemo(() => {
    if (!state || !draft) return null;
    const g = layoutFeatureLanes({ ...state, cards: draft.map((feature) => ({ feature, analysis: null })) });
    return { ...g, nodes: g.nodes.map((n) => ({ ...n, tone: n.id === selected ? ("focus" as const) : n.tone, onClick: () => {
      reviewStore.set((s) => ({ ...s, selected: n.id }));
      inspectorStore.set((s) => ({ ...s, open: true }));
    } })) };
  }, [state, draft, selected]);

  if (!state) return <div className="center-msg"><span className="spinner" /></div>;
  if (!state.map) return <div className="center-msg">No feature map yet. Find the features from the overview first.</div>;
  if (!graph) return null;
  return <Diagram nodes={graph.nodes} edges={graph.edges} sections={graph.sections} quietEdges label="Proposed features" />;
}

/** The optional editor: rename, change kind, move files, merge, remove. Nothing waits on it. */
export function ReviewPanel() {
  const state = useFeatures();
  const { draft, selected, dirty } = useStore(reviewStore);
  const [saving, setSaving] = useState(false);
  if (!state?.map || !draft) return null;
  const feature = draft.find((f) => f.id === selected) ?? null;
  const others = draft.filter((f) => f.id !== selected);

  const save = async (approve: boolean) => {
    setSaving(true);
    try {
      await api.saveFeatures(draft, approve);
      reviewStore.set({ draft: null, selected: null, dirty: false });
      // Features whose files changed are checked again straight away; the rest stay as they are.
      await startPrepare();
      if (approve) navigate({ view: "system" });
    } finally {
      setSaving(false);
    }
  };
  const moveFile = (file: string, to: string) =>
    updateDraft((fs) => fs.map((f) => (f.id === to ? { ...f, files: [...f.files, file] } : { ...f, files: f.files.filter((x) => x !== file) })));

  return (
    <div className="review">
      <div className="i-head">
        <div className="kick">Review</div>
        <div className="i-title">Is this how you'd describe the app?</div>
        <p className="review-lead">Docent found {draft.length} features in the code. If one is named oddly or a file sits in the wrong place, fix it here. Optional: everything already works without it. Features you change are checked again.</p>
      </div>

      {feature ? (
        <div className="review-edit">
          <label className="field">
            <span>Name</span>
            <input value={feature.name} onChange={(e) => updateDraft((fs) => fs.map((f) => (f.id === feature.id ? { ...f, name: e.target.value } : f)))} />
          </label>
          <label className="field">
            <span>What it does</span>
            <textarea rows={2} value={feature.summary} onChange={(e) => updateDraft((fs) => fs.map((f) => (f.id === feature.id ? { ...f, summary: e.target.value } : f)))} />
          </label>
          <div className="field-row">
            <label className="field">
              <span>Kind</span>
              <select value={feature.kind} onChange={(e) => updateDraft((fs) => fs.map((f) => (f.id === feature.id ? { ...f, kind: e.target.value as Feature["kind"] } : f)))}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Merge into</span>
              <select value="" onChange={(e) => {
                const into = e.target.value;
                if (!into) return;
                updateDraft((fs) => fs.filter((f) => f.id !== feature.id).map((f) => (f.id === into ? { ...f, files: [...f.files, ...feature.files], entryPoints: [...f.entryPoints, ...feature.entryPoints] } : f)));
                reviewStore.set((s) => ({ ...s, selected: into }));
              }}>
                <option value="">Choose…</option>
                {others.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
          </div>
          <p className="review-why"><b>Why Claude grouped it:</b> {feature.reason}</p>
          <Group title="Files" count={feature.files.length} open>
            {feature.files.map((file) => (
              <div key={file} className="file-row">
                <span className="mono grow" title={file}>{shortPath(file, 3)}</span>
                <select aria-label={`Move ${file}`} value="" onChange={(e) => e.target.value && moveFile(file, e.target.value)}>
                  <option value="">Move…</option>
                  {others.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
            ))}
          </Group>
          <button className="link danger" onClick={() => {
            updateDraft((fs) => fs.filter((f) => f.id !== feature.id));
            reviewStore.set((s) => ({ ...s, selected: null }));
          }}>Remove this feature (its files become unassigned)</button>
        </div>
      ) : (
        <p className="review-hint">Select a feature on the canvas to edit it.</p>
      )}

      <Group title="All features" count={draft.length} open={!feature}>
        {draft.map((f) => (
          <button key={f.id} className={`row${f.id === selected ? " sel" : ""}`} onClick={() => reviewStore.set((s) => ({ ...s, selected: f.id }))}>
            <span className="grow">{f.name}</span><span className="sub">{f.files.length} files</span>
          </button>
        ))}
      </Group>
      {state.map.unassigned.length > 0 && (
        <Group title="Not in any feature" count={state.map.unassigned.length}>
          {state.map.unassigned.map((u) => (
            <div key={u.file} className="unassigned">
              <span className="mono">{shortPath(u.file, 3)}</span>
              <p>{u.guess}</p>
            </div>
          ))}
        </Group>
      )}
      {state.map.notes.length > 0 && (
        <Group title="Fixed by the mechanical check" count={state.map.notes.length}>
          {state.map.notes.map((n, i) => <p key={i} className="note-line">{n}</p>)}
        </Group>
      )}

      <div className="review-actions">
        <button className="primary-btn" disabled={saving || !dirty} onClick={() => void save(true)}>{saving ? "Saving…" : "Save changes"}</button>
        <button className="ghost-btn" disabled={saving} onClick={() => navigate({ view: "system" })}>{dirty ? "Discard" : "Done"}</button>
      </div>
    </div>
  );
}
