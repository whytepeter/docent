import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { navigate } from "../../shared/state/router.ts";
import { createStore, useStore } from "../../shared/state/store.ts";
import { Icon } from "../../shared/ui/index.ts";
import "./search.css";

export const searchStore = createStore(false);
export const openSearch = () => searchStore.set(true);

/** ⌘K: jump to any function, file or area by typing a few letters. */
export function SearchPalette() {
  const open = useStore(searchStore);
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchStore.set((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setText("");
      setHits([]);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!text.trim()) return setHits([]);
    let live = true;
    const t = setTimeout(() => api.search(text).then((h) => live && (setHits(h), setActive(0))), 60);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text]);

  if (!open) return null;
  const go = (hit: SearchHit | undefined) => {
    if (!hit) return;
    navigate(hit.route);
    searchStore.set(false);
  };
  return (
    <>
      <div className="scrim" onClick={() => searchStore.set(false)} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette-in">
          <Icon name="search" />
          <input
            ref={input}
            value={text}
            placeholder="Jump to a function, file or area"
            aria-label="Search"
            aria-controls="palette-results"
            aria-activedescendant={hits[active] ? `hit-${active}` : undefined}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") searchStore.set(false);
              else if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(hits.length - 1, a + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
              else if (e.key === "Enter") go(hits[active]);
            }}
          />
          <kbd>esc</kbd>
        </div>
        {hits.length > 0 && (
          <ul id="palette-results" role="listbox">
            {hits.map((h, i) => (
              <li key={`${h.kind}:${h.detail}:${h.label}`} id={`hit-${i}`} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseMove={() => setActive(i)} onClick={() => go(h)}>
                <Icon name={h.kind === "area" ? "area" : h.kind === "file" ? "file" : h.symbolKind === "component" ? "component" : "fn"} size={14} />
                <span className={h.kind === "area" ? "" : "mono"}>{h.label}</span>
                <span className="detail">{h.detail}</span>
              </li>
            ))}
          </ul>
        )}
        {text.trim() && hits.length === 0 && <div className="palette-empty">Nothing matches “{text}”</div>}
      </div>
    </>
  );
}
