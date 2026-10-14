import { useEffect, useRef } from "react";
import { useStore } from "../../shared/state/store.ts";
import { Icon } from "../../shared/ui/index.ts";
import { CodeView } from "./CodeView.tsx";
import { codeSheet } from "./sheet-store.ts";

/** A sheet over the app with a whole file, scrolled to the lines that matter. */
export function CodeSheet() {
  const target = useStore(codeSheet);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!target) return;
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && codeSheet.set(null);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [target]);

  if (!target) return null;
  const name = target.path.split("/").pop();
  const where = target.focus ? (target.focus[0] === target.focus[1] ? `line ${target.focus[0]}` : `lines ${target.focus[0]}–${target.focus[1]}`) : "";
  return (
    <>
      <div className="scrim" onClick={() => codeSheet.set(null)} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`${name} ${where}`}>
        <header>
          <div>
            <h3>{name}{where && <span> · {where}</span>}</h3>
            <div className="path">{target.path}</div>
          </div>
          <button ref={close} className="tbtn" aria-label="Close" onClick={() => codeSheet.set(null)}><Icon name="close" /></button>
        </header>
        <div className="sheet-body" data-scroll>
          <CodeView path={target.path} focus={target.focus ?? null} scrollToFocus />
        </div>
      </div>
    </>
  );
}
