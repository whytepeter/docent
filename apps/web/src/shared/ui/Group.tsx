import { useEffect, useRef, type ReactNode } from "react";
import { inspectorStore } from "../state/inspector.ts";
import { useStore } from "../state/store.ts";

/** A collapsed section in the inspector. Details stay hidden until asked for. */
export function Group({ id, title, count, open = false, children }: { id?: string; title: string; count?: number; open?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const { focusGroup } = useStore(inspectorStore);
  useEffect(() => {
    if (id && focusGroup === id && ref.current) {
      ref.current.open = true;
      ref.current.scrollIntoView({ block: "start", behavior: "smooth" });
      inspectorStore.set((s) => ({ ...s, focusGroup: null }));
    }
  }, [focusGroup, id]);
  return (
    <details ref={ref} className="group" open={open}>
      <summary>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </summary>
      <div className="body">{count === 0 ? <div className="empty">None</div> : children}</div>
    </details>
  );
}
