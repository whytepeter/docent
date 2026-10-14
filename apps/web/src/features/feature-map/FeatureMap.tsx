import type { FeatureCard, FeaturesState } from "@docent/contracts";
import { cardHeight, lanes } from "../../shared/graph/index.ts";
import { navigate } from "../../shared/state/router.ts";

const KIND_LABEL: Record<string, string> = { "user-facing": "what users do", operator: "what operators do", background: "runs in the background", shared: "shared foundations" };
const KIND_HUE = { "user-facing": "features", operator: "app", background: "components", shared: "shared" } as const;

/** The overview once features exist: one framed lane per kind, links between features that import each other. */
export function layoutFeatures(state: FeaturesState) {
  const cards = state.cards;
  const fileOwner = new Map<string, string>();
  for (const c of cards) for (const f of c.feature.files) fileOwner.set(f, c.feature.id);
  const specs = cards.map((c) => ({
    id: c.feature.id,
    lane: KIND_LABEL[c.feature.kind] ?? c.feature.kind,
    hue: KIND_HUE[c.feature.kind as keyof typeof KIND_HUE] ?? "other",
    icon: "area" as const,
    title: c.feature.name,
    meta: metaFor(c),
    tone: c.analysis?.status === "dead" ? ("warn" as const) : ("default" as const),
    h: cardHeight({}),
    onClick: () => navigate({ view: "feature", id: c.feature.id }),
  }));
  return { specs, fileOwner };
}

function metaFor(c: FeatureCard) {
  const meta: { icon: "file" | "test" | "fn"; value: string | number; label: string }[] = [{ icon: "file", value: c.feature.files.length, label: "files" }];
  if (c.analysis) meta.push({ icon: "test", value: `${c.analysis.confirmed}/${c.analysis.claims}`, label: "claims confirmed" });
  return meta;
}

export const layoutFeatureLanes = (state: FeaturesState) => {
  const { specs } = layoutFeatures(state);
  const links = state.links.map((l, i) => ({ id: `fl${i}`, from: l.from, to: l.to, width: Math.min(3, 1 + Math.log2(l.count) / 2) }));
  return lanes(specs, links, { first: ["what users do"], last: ["shared foundations"] });
};
