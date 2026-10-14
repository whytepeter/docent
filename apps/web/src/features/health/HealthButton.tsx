import { useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { navigate } from "../../shared/state/router.ts";
import { Group, Icon, shortPath } from "../../shared/ui/index.ts";
import { openCode } from "../code/index.ts";
import "./health.css";

/** A quiet badge in the toolbar. The merged list of problems, from facts and from verification, opens only when asked for. */
export function HealthButton() {
  const { data } = useQuery("health", api.health);
  // Verification findings; empty until features are discovered and verified.
  const { data: analysis } = useQuery("analysis-health", () => api.analysisHealth().catch(() => null));
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !pop.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    setTimeout(() => window.addEventListener("mousedown", onDown));
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!data) return null;
  const docs = data.missingPaths.filter((m) => m.kind === "doc");
  const issues = analysis?.issues ?? [];
  const mismatches = analysis?.docMismatches ?? [];
  const disputed = analysis?.disputed ?? [];
  const stale = analysis?.stale ?? [];
  const serious = issues.filter((i) => i.severity !== "low").length;
  const count = docs.length + mismatches.length + serious + data.unreferenced.length;
  if (!count && !issues.length && !disputed.length && !data.inferred.length) return null;
  const close = () => setOpen(false);
  return (
    <>
      <button className={`tbtn${count ? " warn" : ""}`} aria-expanded={open} aria-haspopup="dialog" title="Health" onClick={() => setOpen((v) => !v)}>
        <Icon name="warn" />{count || null}
      </button>
      {open && (
        <div ref={pop} className="pop" role="dialog" aria-label="Health">
          <h3>Things to know</h3>
          <p>Where the docs and the code disagree, what verification found, and what not to rely on. Each one opens the exact place.</p>
          <Group title="Docs that disagree with the code" count={docs.length + mismatches.length} open>
            {docs.map((m) => (
              <button key={`${m.doc}:${m.line}:${m.text}`} className="row two" onClick={() => (openCode(m.doc, m.line), close())}>
                <span className="dot problem" />
                <span className="grow">
                  <span className="mono">{m.text}</span>
                  <span className="why">{m.missingKind === "name" && m.removedIn ? `removed in ${m.removedIn.sha}: “${m.removedIn.subject}”` : "no such file"}</span>
                </span>
                <span className="sub">{shortPath(m.doc, 1)}:{m.line}</span>
              </button>
            ))}
            {mismatches.map((m, i) => (
              <button key={`mm${i}`} className="row two" onClick={() => (m.at ? openCode(m.at.file, m.at.start, m.at.end) : navigate({ view: "feature", id: m.featureId }), close())}>
                <span className={`dot ${m.label}`} />
                <span className="grow"><span>{m.text}</span><span className="why">{m.feature}</span></span>
              </button>
            ))}
          </Group>
          <Group title="Found while verifying features" count={issues.length} open={issues.length > 0 && issues.length < 8}>
            {issues.map((i, n) => (
              <button key={`is${n}`} className="row two" title={i.detail} onClick={() => (i.at ? openCode(i.at.file, i.at.start, i.at.end) : navigate({ view: "feature", id: i.featureId }), close())}>
                <span className={`sev ${i.severity}`}>{i.severity}</span>
                <span className="grow"><span>{i.title}</span><span className="why">{i.feature}</span></span>
              </button>
            ))}
          </Group>
          <Group title="Claims taken back" count={disputed.length}>
            {disputed.map((d, n) => (
              <button key={`dp${n}`} className="row two" onClick={() => (navigate({ view: "feature", id: d.featureId }), close())}>
                <span className={`dot ${d.label}`} />
                <span className="grow"><span>{d.text}</span><span className="why">Was “{d.claimedLabel}”; {d.note}</span></span>
              </button>
            ))}
          </Group>
          {stale.length > 0 && (
            <Group title="Verified before the code changed" count={stale.length} open>
              {stale.map((f) => (
                <button key={f.featureId} className="row" onClick={() => (navigate({ view: "feature", id: f.featureId }), close())}>
                  <span className="dot inferred" /><span className="grow">{f.feature}</span><span className="sub">re-verify</span>
                </button>
              ))}
            </Group>
          )}
          <Group title="Files nothing imports" count={data.unreferenced.length} open={data.unreferenced.length < 6}>
            {data.unreferenced.map((u) => (
              <button key={u.file} className="row" onClick={() => (navigate({ view: "file", path: u.file }), close())}>
                <span className="grow mono">{shortPath(u.file, 3)}</span>
              </button>
            ))}
          </Group>
          <Group title="Links that are guesses" count={data.inferred.length}>
            {data.inferred.slice(0, 50).map((e) => (
              <button key={`${e.from}>${e.to}:${e.line}`} className="row" title={e.via} onClick={() => (openCode(e.file, e.line), close())}>
                <span className="dot inferred" /><span className="grow mono">{e.to.split("#")[1]}</span><span className="sub">{shortPath(e.file, 1)}:{e.line}</span>
              </button>
            ))}
          </Group>
        </div>
      )}
    </>
  );
}
