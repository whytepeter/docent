import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoCacheDir } from "@docent/extract";
import type { FeatureAnalysis, FeatureMap } from "./types.ts";

const featuresFile = (root: string) => join(repoCacheDir(root), "features.json");
const analysisDir = (root: string) => {
  const dir = join(repoCacheDir(root), "analysis");
  mkdirSync(dir, { recursive: true });
  return dir;
};

export function loadFeatureMap(root: string): FeatureMap | null {
  try {
    return JSON.parse(readFileSync(featuresFile(root), "utf8")) as FeatureMap;
  } catch {
    return null;
  }
}

export function saveFeatureMap(root: string, map: FeatureMap): void {
  writeFileSync(featuresFile(root), JSON.stringify(map, null, 2));
}

export function saveAnalysis(root: string, a: FeatureAnalysis): void {
  writeFileSync(join(analysisDir(root), `${a.featureId}.json`), JSON.stringify(a, null, 2));
}

export function loadAnalysis(root: string, id: string): FeatureAnalysis | null {
  const file = join(analysisDir(root), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as FeatureAnalysis;
  } catch {
    return null;
  }
}

export function listAnalyses(root: string): FeatureAnalysis[] {
  return readdirSync(analysisDir(root)).filter((f) => f.endsWith(".json")).map((f) => loadAnalysis(root, f.slice(0, -5))).filter((a): a is FeatureAnalysis => !!a);
}
