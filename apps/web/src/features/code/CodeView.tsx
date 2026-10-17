import { useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { useStore } from "../../shared/state/store.ts";
import { editorThemeStore } from "./editor-theme.ts";
import { toHtml } from "./highlighter.ts";
import "./code.css";

/** Real code from the repo, highlighted, with the focus lines marked. Loads only the slice it shows. */
export function CodeView({ path, from, to, focus, scrollToFocus = false }: {
  path: string;
  from?: number;
  to?: number;
  focus?: [number, number] | null;
  scrollToFocus?: boolean;
}) {
  const { data, error } = useQuery(`source:${path}:${from ?? ""}:${to ?? ""}`, () => api.source(path, from, to));
  const [html, setHtml] = useState("");
  const theme = useStore(editorThemeStore);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data) return;
    let live = true;
    toHtml(data.lines, path, data.start, focus ?? null).then((h) => live && setHtml(h));
    return () => {
      live = false;
    };
  }, [data, path, focus?.[0], focus?.[1], theme]);

  useEffect(() => {
    if (!html || !scrollToFocus || !ref.current) return;
    const line = ref.current.querySelector<HTMLElement>(".line.on");
    const scroller = ref.current.closest<HTMLElement>("[data-scroll]") ?? ref.current;
    if (line) scroller.scrollTop = Math.max(0, line.offsetTop - 80);
  }, [html, scrollToFocus]);

  if (error) return <div className="empty">{error.message}</div>;
  if (!html) return <div className="code-loading"><span className="spinner" /></div>;
  return <div ref={ref} className="code" dangerouslySetInnerHTML={{ __html: html }} />;
}
