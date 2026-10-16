import { useEffect, useMemo, useRef, useState } from "react";
import type { Route, TreeNode } from "@docent/contracts";
import { api } from "../../shared/api/client.ts";
import { useQuery } from "../../shared/api/useQuery.ts";
import { useFeatures } from "../../shared/api/features.ts";
import { navigate, useRoute } from "../../shared/state/router.ts";
import { sidebarStore } from "../../shared/state/chrome.ts";
import { useStore } from "../../shared/state/store.ts";
import { Icon } from "../../shared/ui/index.ts";
import "./navigator.css";

const keyOf = (r: Route) => (r.view === "area" ? r.id : r.view === "file" ? r.path : r.view === "fn" ? r.id : "");

/** Where you are: a tree from the whole repo down to functions. Opens itself to the current item. */
export function Navigator({ repoName, head, onOpenRepo }: { repoName: string; head: string | null; onOpenRepo: () => void }) {
  const { data } = useQuery("tree", api.tree);
  const route = useRoute();
  const current = keyOf(route);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const expanded = useStore(sidebarStore);
  const features = useFeatures();

  // Expand the path down to whatever is on screen.
  const ancestry = useMemo(() => {
    const path: string[] = [];
    const walk = (nodes: TreeNode[], trail: string[]): boolean => {
      for (const n of nodes) {
        if (n.id === current || (route.view === "fn" && current.startsWith(`${n.id}#`))) {
          path.push(...trail, n.id);
          return true;
        }
        if (n.children && walk(n.children, [...trail, n.id])) return true;
      }
      return false;
    };
    if (data && current) walk(data, []);
    return path;
  }, [data, current, route.view]);

  useEffect(() => {
    if (ancestry.length) setOpen((s) => new Set([...s, ...ancestry.slice(0, -1)]));
  }, [ancestry]);

  const toggle = (id: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  if (!expanded) {
    return (
      <button className="float sidebar-pill" onClick={() => sidebarStore.set(true)} aria-label="Show the map" title="Show the map ( [ )">
        <span className="brand-mark" aria-hidden="true">d</span>
        <b>{repoName}</b>
        <Icon name="sidebar" size={16} />
      </button>
    );
  }

  return (
    <aside className="float sidebar" aria-label="Map">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">d</span><b>Docent</b>
        <button className="tbtn collapse" onClick={() => sidebarStore.set(false)} aria-label="Hide the map" title="Hide the map ( [ )">
          <Icon name="sidebar" size={16} />
        </button>
      </div>
      <button className="proj" onClick={onOpenRepo} title="Open another codebase">
        <span className="proj-text"><b>{repoName}</b><span>{head ?? "no commits"}</span></span>
        <Icon name="folder" size={15} />
      </button>
      <nav className="tree" aria-label="Codebase">
        <Item depth={0} icon="system" label="Overview" selected={route.view === "system"} onSelect={() => navigate({ view: "system" })} />
        {features?.map && (
          <div className="section">
            <div className="sb-head" data-hue="features"><i aria-hidden="true" />Features</div>
            {features.cards.map((c) => (
              <Item key={c.feature.id} depth={0} icon="area" label={c.feature.name} selected={route.view === "feature" && route.id === c.feature.id} onSelect={() => navigate({ view: "feature", id: c.feature.id })} />
            ))}
            <div className="sb-head subtle">Folders</div>
          </div>
        )}
        {sections(data ?? []).map(([group, nodes]) => (
          <div key={group} className="section">
            <div className="sb-head" data-hue={["app", "features", "components", "shared"].includes(group) ? group : "other"}><i aria-hidden="true" />{group}</div>
            {nodes.map((n) => <Branch key={n.id} node={n} depth={0} open={open} toggle={toggle} current={current} />)}
          </div>
        ))}
      </nav>
    </aside>
  );
}

/** Areas grouped under their folder (app, features, shared…), so two "Hooks" areas stay distinct. */
function sections(nodes: TreeNode[]): [string, TreeNode[]][] {
  const map = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    const g = n.group ?? "top level";
    map.set(g, [...(map.get(g) ?? []), n]);
  }
  return [...map].sort(([a], [b]) => (a === "top level" ? -1 : b === "top level" ? 1 : a.localeCompare(b)));
}

function Branch({ node, depth, open, toggle, current }: { node: TreeNode; depth: number; open: Set<string>; toggle: (id: string) => void; current: string }) {
  const isOpen = open.has(node.id);
  const icon = node.kind === "area" ? "area" : node.kind === "file" ? "file" : node.symbolKind === "component" ? "component" : "fn";
  return (
    <>
      <Item
        depth={depth}
        icon={icon}
        label={node.label}
        mono={node.kind !== "area"}
        selected={node.id === current}
        expandable={!!node.children?.length}
        expanded={isOpen}
        onToggle={() => toggle(node.id)}
        onSelect={() => {
          navigate(node.route);
          if (node.children?.length && !isOpen) toggle(node.id);
        }}
      />
      {isOpen && node.children?.map((c) => <Branch key={c.id} node={c} depth={depth + 1} open={open} toggle={toggle} current={current} />)}
    </>
  );
}

function Item({ depth, icon, label, mono, selected, expandable, expanded, onToggle, onSelect }: {
  depth: number; icon: Parameters<typeof Icon>[0]["name"]; label: string; mono?: boolean; selected: boolean;
  expandable?: boolean; expanded?: boolean; onToggle?: () => void; onSelect: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div ref={ref} className={`item${selected ? " sel" : ""}`} style={{ paddingLeft: 8 + depth * 14 }}>
      <button className={`disc${expanded ? " open" : ""}`} aria-label={expanded ? "Collapse" : "Expand"} tabIndex={-1} onClick={onToggle} style={{ visibility: expandable ? "visible" : "hidden" }}>
        <Icon name="chevron" size={11} weight="bold" />
      </button>
      <button className="lbl" aria-current={selected || undefined} onClick={onSelect}>
        <Icon name={icon} size={15} />
        <span className={mono ? "mono" : undefined}>{label}</span>
      </button>
    </div>
  );
}
