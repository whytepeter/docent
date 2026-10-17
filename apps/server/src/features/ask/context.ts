import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listAnalyses, loadAnalysis, loadBoard, loadFeatureMap, type FeatureAnalysis } from "@docent/analyze";
import type { Route } from "@docent/contracts";
import type { GraphIndex } from "../graph/index.ts";

const MAX_CODE = 140;

/**
 * What Claude gets to know about the view the question was asked from: the facts behind it,
 * the code when it's one function, and what verification already established (with labels).
 */
export function viewContext(root: string, index: GraphIndex, route: Route): string {
  const map = loadFeatureMap(root);
  const out: string[] = [];
  const claims = (a: FeatureAnalysis, file?: string) =>
    a.claims
      .filter((c) => !file || c.evidence.some((e) => e.file === file))
      .slice(0, 14)
      .map((c) => `  - [${c.label}] ${c.text}${c.evidence[0] ? ` (${c.evidence[0].file}:${c.evidence[0].start}-${c.evidence[0].end})` : ""}`);
  const featuresOf = (file: string) => (map?.features ?? []).filter((f) => f.files.includes(file));
  const analysisBlock = (featureId: string, file?: string) => {
    const f = map?.features.find((x) => x.id === featureId);
    const a = loadAnalysis(root, featureId);
    if (!f) return [];
    return [
      `Feature "${f.name}" (${f.kind}): ${a?.summary ?? f.summary}`,
      ...(a ? [`  Status: ${a.status}. ${a.statusReason}`, ...(file ? [] : a.flow.map((s, i) => `  Step ${i + 1}: ${s.step} (${s.file}:${s.start}-${s.end})`)), "  What verification found:", ...claims(a, file)] : ["  Not verified yet."]),
    ];
  };

  out.push(`Repository: ${root.split("/").pop()}. The developer is looking at:`);
  switch (route.view) {
    case "fn": {
      const v = index.symbolView(route.id);
      if (!v) break;
      const s = v.symbol;
      out.push(`The function view of ${s.label} (${s.kind}) in ${s.file}, lines ${s.line}-${s.end}.`);
      out.push(`Called by: ${v.callers.map((l) => `${l.symbol.label} (${l.file}:${l.lines[0]}, ${l.confidence})`).join("; ") || "nothing in the repo"}`);
      out.push(`Calls: ${v.callees.map((l) => `${l.symbol.label} (line ${l.lines.join(",")}, ${l.confidence})`).join("; ") || "nothing in the repo"}`);
      out.push(`Tests that reach it: ${v.tests.map((t) => `${t.name} (${t.file}:${t.line})`).join("; ") || "none"}`);
      const lines = readFileSync(join(root, s.file), "utf8").split("\n").slice(s.line - 1, Math.min(s.end, s.line + MAX_CODE - 1));
      out.push("", `Its code (${s.file}):`, ...lines.map((l, i) => `${s.line + i} | ${l}`));
      for (const f of featuresOf(s.file)) out.push("", ...analysisBlock(f.id, s.file));
      break;
    }
    case "file": {
      const v = index.fileView(route.path);
      if (!v) break;
      out.push(`The file view of ${route.path} (${v.file.lines} lines).`);
      out.push(`Inside it: ${v.symbols.map((x) => `${x.label} (line ${x.line})`).join("; ") || "no functions"}`);
      out.push(`Imported by: ${v.importers.map((i) => `${i.file} (${i.names.join(", ")})`).join("; ") || "nothing"}`);
      out.push(`Imports: ${v.imports.map((i) => i.file ?? i.external).join("; ") || "nothing"}`);
      for (const f of featuresOf(route.path)) out.push("", ...analysisBlock(f.id, route.path));
      break;
    }
    case "area": {
      const v = index.areaView(route.id);
      if (!v) break;
      out.push(`The folder "${v.area.label}" (${v.area.path}): ${v.files.map((f) => f.path).join(", ")}`);
      break;
    }
    case "board": {
      const b = loadBoard(root, route.id);
      if (!b) break;
      const step = route.step !== undefined ? b.steps[route.step] : undefined;
      const focus = route.card ?? step?.card;
      out.push(`A whiteboard that explains one flow: "${b.title}". ${b.intro}`);
      if (step) out.push(`They're on tour step ${route.step! + 1} of ${b.steps.length}, where Docent says: "${step.beats.map((bt) => bt.text).join(" ")}"`);
      out.push("", "The cards on the board, in the order a request meets them (id — title — file:lines — what it does):");
      for (const c of b.cards) out.push(`- ${c.id} — ${c.title} — ${c.file}:${c.start}-${c.start + c.lines.length - 1} — ${c.role}`);
      const f = b.cards.find((c) => c.id === focus);
      if (f) out.push("", `The card they're looking at, "${f.title}" (${f.file}):`, ...f.lines.map((l, i) => `${String(f.start + i).padStart(5)}  ${l}`));
      out.push("", "What the board already says, with labels:", ...b.cards.flatMap((c) => [`  - [${c.why.label}] ${c.title}: ${c.why.text}`]).slice(0, 12));
      break;
    }
    case "feature":
      out.push("A feature's verified flow, step by step.", "", ...analysisBlock(route.id));
      break;
    default: {
      const analyzed = new Map(listAnalyses(root).map((a) => [a.featureId, a]));
      out.push("The overview: the whole system as features.");
      for (const f of map?.features ?? []) out.push(`- ${f.name} (${f.kind}): ${analyzed.get(f.id)?.summary ?? f.summary}`);
      if (!map) out.push(...index.overview().areas.map((a) => `- folder ${a.label}: ${a.files} files`));
    }
  }
  return out.join("\n");
}
