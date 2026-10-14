import { useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { navigate } from "../../shared/state/router.ts";
import { Group, Icon, shortPath } from "../../shared/ui/index.ts";
import { openCode } from "../code/index.ts";
import "./health.css";

/** A quiet badge in the toolbar. The list of problems opens only when asked for. */
export function HealthButton() {
  const { data } = useQuery("health", api.health);
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
  const issues = docs.length + data.unreferenced.length;
  if (!issues && !data.inferred.length) return null;
  return (
    <>
      <button className={`tbtn${issues ? " warn" : ""}`} aria-expanded={open} aria-haspopup="dialog" title="Health" onClick={() => setOpen((v) => !v)}>
        <Icon name="warn" />{issues || null}
      </button>
      {open && (
        <div ref={pop} className="pop" role="dialog" aria-label="Health">
          <h3>Things to know</h3>
          <p>Places where the docs or the code look off. Each one opens the exact line.</p>
          <Group title="Docs that point at files that don’t exist" count={docs.length} open>
            {docs.map((m) => (
              <button key={`${m.doc}:${m.line}:${m.text}`} className="row" onClick={() => (openCode(m.doc, m.line), setOpen(false))}>
                <span className="grow mono">{m.text}</span><span className="sub">{shortPath(m.doc, 1)}:{m.line}</span>
              </button>
            ))}
          </Group>
          <Group title="Files nothing imports" count={data.unreferenced.length} open={data.unreferenced.length < 6}>
            {data.unreferenced.map((u) => (
              <button key={u.file} className="row" onClick={() => (navigate({ view: "file", path: u.file }), setOpen(false))}>
                <span className="grow mono">{shortPath(u.file, 3)}</span>
              </button>
            ))}
          </Group>
          <Group title="Links that are guesses" count={data.inferred.length}>
            {data.inferred.slice(0, 50).map((e) => (
              <button key={`${e.from}>${e.to}:${e.line}`} className="row" title={e.via} onClick={() => (openCode(e.file, e.line), setOpen(false))}>
                <span className="dot inferred" /><span className="grow mono">{e.to.split("#")[1]}</span><span className="sub">{shortPath(e.file, 1)}:{e.line}</span>
              </button>
            ))}
          </Group>
        </div>
      )}
    </>
  );
}
