import { useEffect, useState } from "react";
import type { BundledTheme, ThemedToken } from "shiki";
import { useStore } from "../../shared/state/store.ts";
import { Icon } from "../../shared/ui/index.ts";
import { EDITOR_THEMES, editorThemeStore } from "./editor-theme.ts";
import { loadEditorTheme } from "./highlighter.ts";

const FILE = "upload.ts";
const SAMPLE = `async function send(file: File) {
  try {
    return await upload(file);
  } catch (error) {
    if (error.status !== 403) throw error;
    return upload(file, await presign());
  }
}`;
/** The line the mini editor's cursor sits on. */
const CURSOR = 5;

/** A theme as the mini editor draws it: its highlighted sample, and the colours of the editor around the code. */
interface Look {
  lines: ThemedToken[][];
  bg: string;
  fg: string;
  gutter: string;
  current: string;
  chrome: string;
  tab: string;
  border: string;
  status: string;
  statusFg: string;
}

const mix = (a: string, b: string, pct: number) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

async function lookOf(id: BundledTheme): Promise<Look> {
  const hl = await loadEditorTheme(id);
  const t = hl.getTheme(id);
  const c = t.colors ?? {};
  const edge = t.type === "light" ? "#000" : "#fff";
  return {
    lines: hl.codeToTokens(SAMPLE, { lang: "ts", theme: id }).tokens,
    bg: t.bg,
    fg: t.fg,
    gutter: c["editorLineNumber.foreground"] ?? mix(t.fg, t.bg, 40),
    current: c["editor.lineHighlightBackground"] ?? mix(t.fg, t.bg, 6),
    chrome: c["titleBar.activeBackground"] ?? c["editorGroupHeader.tabsBackground"] ?? mix(edge, t.bg, 5),
    tab: c["tab.activeBackground"] ?? t.bg,
    border: c["editorGroup.border"] ?? c["tab.border"] ?? mix(t.fg, t.bg, 12),
    status: c["statusBar.background"] ?? mix(edge, t.bg, 5),
    statusFg: c["statusBar.foreground"] ?? mix(t.fg, t.bg, 70),
  };
}

/** A small editor window in one theme: window bar and tab, numbered code with the cursor's line, a status bar. */
function MiniEditor({ look, name }: { look: Look; name: string }) {
  return (
    <span className="ed-mini" style={{ background: look.bg, color: look.fg, borderColor: look.border }}>
      <span className="ed-bar" style={{ background: look.chrome, borderColor: look.border }}>
        <span className="ed-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="ed-tab" style={{ background: look.tab, color: look.fg, borderColor: look.border }}>{FILE}</span>
      </span>
      <span className="ed-code">
        {look.lines.map((line, i) => (
          <span key={i} className="ed-line" style={i + 1 === CURSOR ? { background: look.current } : undefined}>
            <span className="ed-gutter" style={{ color: i + 1 === CURSOR ? look.fg : look.gutter }}>{i + 1}</span>
            <span className="ed-text">
              {line.map((tk, j) => <span key={j} style={{ color: tk.color, fontStyle: tk.fontStyle === 1 ? "italic" : undefined }}>{tk.content}</span>)}
              {i + 1 === CURSOR && <span className="ed-cursor" style={{ background: look.fg }} />}
            </span>
          </span>
        ))}
      </span>
      <span className="ed-status" style={{ background: look.status, color: look.statusFg, borderColor: look.border }}>
        <span>{name}</span>
        <span>TypeScript · Ln {CURSOR}</span>
      </span>
    </span>
  );
}

/** Dark or light code: each shown as a mini editor, and the code on the board and in the code sheet follows. */
export function EditorThemePicker() {
  const chosen = useStore(editorThemeStore);
  const [looks, setLooks] = useState<Partial<Record<BundledTheme, Look>>>({});
  useEffect(() => {
    let live = true;
    void Promise.all(EDITOR_THEMES.map(async (t) => [t.id, await lookOf(t.id)] as const)).then((all) => live && setLooks(Object.fromEntries(all)));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="ed-pick" role="radiogroup" aria-label="Editor theme">
      {EDITOR_THEMES.map((t) => {
        const look = looks[t.id];
        return (
          <button key={t.id} role="radio" aria-checked={chosen === t.id} onClick={() => editorThemeStore.set(t.id)}>
            {look ? <MiniEditor look={look} name={t.name} /> : <span className="ed-mini ed-loading"><span className="spinner" aria-hidden="true" /></span>}
            <span className="ed-name">
              <span className="ed-radio" aria-hidden="true">{chosen === t.id && <Icon name="check" size={9} weight="bold" />}</span>
              {t.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
