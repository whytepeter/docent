import { useEffect, useState } from "react";
import type { FlowsState } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { Icon } from "../../shared/ui/index.ts";
import { timeLeft, useNow } from "../jobs/index.ts";

/**
 * Boards keep drawing on the server when you leave them. This tray, bottom left on every screen, shows
 * each one's progress, turns into "ready" when it's done, and opens it on a click.
 */
export function Tray({ current, onOpen }: { current: string | null; onOpen: (id: string) => void }) {
  const [items, setItems] = useState<FlowsState["drawing"]>([]);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [asking, setAsking] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const hide = (key: string) => setGone((g) => new Set(g).add(key));
  const stop = (id: string, key: string) => {
    setStopping(key);
    void api.stopBoard(id).finally(() => {
      setStopping(null);
      setAsking(null);
      hide(key);
    });
  };
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await api.flows();
        if (!live) return;
        setItems(s.drawing ?? []);
        t = setTimeout(() => void tick(), s.drawing?.some((d) => !d.job.finishedAt) ? 2000 : 8000);
      } catch {
        if (live) t = setTimeout(() => void tick(), 8000);
      }
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [current]);
  const shown = items.filter((d) => d.id !== current && !gone.has(`${d.id}@${d.job.startedAt}`) && !(d.job.finishedAt && !d.job.done.includes("board")));
  const now = useNow(shown.some((d) => !d.job.finishedAt));
  if (!shown.length) return null;
  return (
    <div className={`bd-tray${current ? " on-board" : ""}`} role="status" aria-live="polite">
      {shown.map((d) => {
        const key = `${d.id}@${d.job.startedAt}`;
        // The board is usable once it's drawn; the double-check finishes behind it.
        const ready = d.job.done.includes("board");
        const est = d.job.estimateSeconds ?? 1;
        const p = Math.min(0.96, Math.max(0.04, (now - Date.parse(d.job.startedAt)) / 1000 / est));
        return (
          <div key={key} className={`bd-tray-item${ready ? " ready" : ""}`}>
            <button className="bd-tray-open" onClick={() => (ready && setGone((g) => new Set(g).add(key)), onOpen(d.id))} title={ready ? "Open the board" : "Open to watch it draw"}>
              {ready ? <span className="bd-tray-ok"><Icon name="check" size={13} weight="bold" /></span> : null}
              <span className="bd-tray-t">
                <b>{d.title}</b>
                <small>{ready ? "Board ready · open it" : `${Math.round(p * 100)}% · ${timeLeft(d.job, now) || "almost done"}`}</small>
                {!ready && (
                  <span className="bd-tray-track" aria-label={`${Math.round(p * 100)}% drawn`}>
                    <i style={{ transform: `scaleX(${p})` }} />
                  </span>
                )}
                {!ready && d.job.stage && <small className="bd-tray-stage">{d.job.stage}</small>}
              </span>
            </button>
            <button className="bd-tray-x" onClick={() => (ready ? hide(key) : setAsking(asking === key ? null : key))} aria-label={ready ? "Dismiss" : "Stop or hide"} title={ready ? "Dismiss" : "Stop or hide"}><Icon name="close" size={13} /></button>
            {asking === key && !ready && (
              <div className="bd-tray-ask" role="alertdialog" aria-label="Stop drawing this board?">
                <p><b>Stop drawing this board?</b><span>Nothing half-drawn is kept. Hide keeps it drawing in the background.</span></p>
                <div>
                  <button onClick={() => setAsking(null)}>Cancel</button>
                  <button onClick={() => (hide(key), setAsking(null))}>Hide</button>
                  <button className="danger" disabled={stopping === key} onClick={() => stop(d.id, key)}>{stopping === key ? "Stopping…" : "Stop"}</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
