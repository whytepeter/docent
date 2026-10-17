import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoCacheDir } from "@docent/extract";
import { upgradeBoard, type Board, type FlowList } from "./board.ts";
import type { ProjectOverview } from "./overview.ts";
import type { Episode } from "./episode.ts";
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

const episodeDir = (root: string) => {
  const dir = join(repoCacheDir(root), "episodes");
  mkdirSync(dir, { recursive: true });
  return dir;
};

export function saveEpisode(root: string, e: Episode): void {
  writeFileSync(join(episodeDir(root), `${e.featureId}.json`), JSON.stringify(e, null, 2));
}

export function loadEpisode(root: string, id: string): Episode | null {
  try {
    return JSON.parse(readFileSync(join(episodeDir(root), `${id}.json`), "utf8")) as Episode;
  } catch {
    return null;
  }
}

const flowsFile = (root: string) => join(repoCacheDir(root), "flows.json");
const boardDir = (root: string) => {
  const dir = join(repoCacheDir(root), "boards");
  mkdirSync(dir, { recursive: true });
  return dir;
};

export function loadFlows(root: string): FlowList | null {
  try {
    return JSON.parse(readFileSync(flowsFile(root), "utf8")) as FlowList;
  } catch {
    return null;
  }
}
export function saveFlows(root: string, f: FlowList): void {
  writeFileSync(flowsFile(root), JSON.stringify(f, null, 2));
}
const overviewFile = (root: string) => join(repoCacheDir(root), "overview.json");
export function loadOverview(root: string): ProjectOverview | null {
  try {
    return JSON.parse(readFileSync(overviewFile(root), "utf8")) as ProjectOverview;
  } catch {
    return null;
  }
}
export function saveOverview(root: string, o: ProjectOverview): void {
  writeFileSync(overviewFile(root), JSON.stringify(o, null, 2));
}
export function loadBoard(root: string, id: string): Board | null {
  try {
    return upgradeBoard(JSON.parse(readFileSync(join(boardDir(root), `${id}.json`), "utf8")) as Board);
  } catch {
    return null;
  }
}
export function saveBoard(root: string, b: Board): void {
  writeFileSync(join(boardDir(root), `${b.flowId}.json`), JSON.stringify(b, null, 2));
}
