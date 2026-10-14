import {
  discoverFeatures, filesHash, listAnalyses, loadAnalysis, loadFeatureMap, saveAnalysis, saveFeatureMap, verifyAll,
  type Feature, type FeatureMap,
} from "@docent/analyze";
import type { FeatureCard, FeaturesState, Job } from "@docent/contracts";
import { pickProvider } from "@docent/llm";
import type { RepoService } from "../repo/index.ts";

/**
 * Discovery and verification as background jobs, one at a time. The app polls the job;
 * results land in the repo's cache as each feature finishes.
 */
export class AnalysisService {
  private job: Job | null = null;

  constructor(private readonly repo: RepoService) {}

  private get root() {
    return this.repo.root;
  }

  state(): FeaturesState {
    const map = loadFeatureMap(this.root);
    const analyses = new Map(listAnalyses(this.root).map((a) => [a.featureId, a]));
    const cards: FeatureCard[] = (map?.features ?? []).map((feature) => {
      const a = analyses.get(feature.id);
      return {
        feature,
        analysis: a ? {
          status: a.status,
          summary: a.summary,
          claims: a.claims.length,
          confirmed: a.claims.filter((c) => c.label === "confirmed").length,
          demoted: a.claims.filter((c) => c.claimedLabel).length,
          issues: a.issues.length,
          stale: a.filesHash !== filesHash(this.repo.facts, feature.files),
        } : null,
      };
    });
    let provider = "unavailable";
    try {
      provider = pickProvider().describe();
    } catch (e) {
      provider = (e as Error).message;
    }
    const owner = new Map<string, string>();
    for (const f of map?.features ?? []) for (const file of f.files) owner.set(file, f.id);
    const counts = new Map<string, number>();
    for (const i of this.repo.facts.imports) {
      if (!i.to || i.kind === "type") continue;
      const a = owner.get(i.from);
      const b = owner.get(i.to);
      if (a && b && a !== b) counts.set(`${a}|${b}`, (counts.get(`${a}|${b}`) ?? 0) + 1);
    }
    const links = [...counts].map(([k, count]) => {
      const [from = "", to = ""] = k.split("|");
      return { from, to, count };
    });
    return { map, cards, job: this.job, provider, links };
  }

  detail(id: string) {
    const map = loadFeatureMap(this.root);
    const feature = map?.features.find((f) => f.id === id);
    if (!feature) return null;
    const analysis = loadAnalysis(this.root, id);
    return { feature, analysis, stale: !!analysis && analysis.filesHash !== filesHash(this.repo.facts, feature.files) };
  }

  private running() {
    return !!this.job && !this.job.finishedAt;
  }

  startDiscovery(): Job {
    if (this.running()) return this.job!;
    const job: Job = { kind: "discover", startedAt: new Date().toISOString(), total: 1, done: [], failed: [], message: "Reading the facts and proposing features" };
    this.job = job;
    void (async () => {
      try {
        const map = await discoverFeatures(pickProvider(), this.repo.facts, this.root);
        saveFeatureMap(this.root, map);
        job.done.push("map");
        job.message = `Proposed ${map.features.length} features`;
      } catch (e) {
        job.error = (e as Error).message;
        job.message = "Discovery failed";
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    })();
    return job;
  }

  startVerify(only?: string): Job {
    if (this.running()) return this.job!;
    const map = loadFeatureMap(this.root);
    const features = (map?.features ?? []).filter((f) => !only || f.id === only);
    const job: Job = { kind: "verify", startedAt: new Date().toISOString(), total: features.length, done: [], failed: [], message: `Verifying ${features.length} features` };
    this.job = job;
    void (async () => {
      try {
        await verifyAll(pickProvider(), this.repo.facts, this.root, features, {
          onDone: (id, r) => {
            if (r instanceof Error) job.failed.push({ id, error: r.message });
            else {
              saveAnalysis(this.root, r);
              job.done.push(id);
            }
            job.message = `Verified ${job.done.length} of ${job.total}`;
          },
        });
      } catch (e) {
        job.error = (e as Error).message;
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    })();
    return job;
  }

  /** Save the user's edits to the map. Only real files survive; every source file stays accounted for. */
  saveEdits(edited: { features: Feature[]; approve?: boolean }): FeatureMap {
    const current = loadFeatureMap(this.root);
    if (!current) throw new Error("No feature map to edit");
    const source = new Set(this.repo.facts.files.filter((f) => f.kind === "source" || f.kind === "generated").map((f) => f.path));
    const seen = new Set<string>();
    const features = edited.features.map((f) => ({
      ...f,
      files: f.files.filter((p) => source.has(p) && !seen.has(p) && (seen.add(p), true)),
    })).filter((f) => f.files.length);
    const unassigned = [...source].filter((p) => !seen.has(p)).map((file) => current.unassigned.find((u) => u.file === file) ?? { file, guess: "Removed from its feature during review" });
    const next: FeatureMap = {
      ...current,
      features,
      unassigned,
      ...(edited.approve ? { state: "approved" as const, approvedAt: new Date().toISOString() } : {}),
    };
    saveFeatureMap(this.root, next);
    return next;
  }
}
