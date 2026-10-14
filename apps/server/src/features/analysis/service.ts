import {
  discoverFeatures, filesHash, listAnalyses, loadAnalysis, loadEpisode, loadFeatureMap, saveAnalysis, saveEpisode, saveFeatureMap, verifyAll, writeEpisode,
  type Feature, type FeatureMap,
} from "@docent/analyze";
import type { AnalysisHealth, EpisodeState, FeatureCard, FeaturesState, Job, PartOf } from "@docent/contracts";
import { pickProvider } from "@docent/llm";
import type { RepoService } from "../repo/index.ts";

/**
 * Discovery and verification as background jobs, one at a time. The app polls the job;
 * results land in the repo's cache as each feature finishes.
 */
export class AnalysisService {
  private job: Job | null = null;
  private abort: AbortController | null = null;

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

  episode(id: string): EpisodeState | null {
    const feature = loadFeatureMap(this.root)?.features.find((f) => f.id === id);
    if (!feature) return null;
    const episode = loadEpisode(this.root, id);
    return { feature, episode, verified: !!loadAnalysis(this.root, id), stale: !!episode && episode.filesHash !== filesHash(this.repo.facts, feature.files) };
  }

  /** Writes a feature's episode in the background: the narration, scenes and claims, checked like verification. */
  startEpisode(id: string): Job {
    if (this.running()) return this.job!;
    const feature = loadFeatureMap(this.root)?.features.find((f) => f.id === id);
    const analysis = loadAnalysis(this.root, id);
    if (!feature || !analysis) throw new Error("Verify the feature before writing its episode");
    const abort = (this.abort = new AbortController());
    const job: Job = { kind: "episode", startedAt: new Date().toISOString(), total: 1, done: [], failed: [], message: `Writing the episode for ${feature.name}` };
    this.job = job;
    void (async () => {
      try {
        saveEpisode(this.root, await writeEpisode(pickProvider(), this.repo.facts, this.root, feature, analysis, { signal: abort.signal }));
        job.done.push(id);
        job.message = "Episode ready";
      } catch (e) {
        if (abort.signal.aborted) return;
        job.error = (e as Error).message;
        job.message = "Couldn't write the episode";
      } finally {
        job.finishedAt ??= new Date().toISOString();
      }
    })();
    return job;
  }

  /** Every verified feature's issues, doc mismatches and taken-back claims, in one list for the health report. */
  health(): AnalysisHealth {
    const map = loadFeatureMap(this.root);
    const out: AnalysisHealth = { issues: [], docMismatches: [], disputed: [], stale: [] };
    const rank = { high: 0, medium: 1, low: 2 };
    for (const f of map?.features ?? []) {
      const a = loadAnalysis(this.root, f.id);
      if (!a) continue;
      const base = { featureId: f.id, feature: f.name };
      if (a.filesHash !== filesHash(this.repo.facts, f.files)) out.stale.push(base);
      const at = (ev: { file: string; start: number; end: number }[]) => (ev[0] ? { file: ev[0].file, start: ev[0].start, end: ev[0].end } : null);
      for (const i of a.issues) out.issues.push({ ...base, title: i.title, detail: i.detail, severity: i.severity, at: at(i.evidence) });
      for (const c of a.claims) {
        if (c.kind === "doc-mismatch") out.docMismatches.push({ ...base, text: c.text, label: c.label, at: at(c.evidence) });
        if (c.claimedLabel && c.checkNote) out.disputed.push({ ...base, text: c.text, claimedLabel: c.claimedLabel, label: c.label, note: c.checkNote });
      }
    }
    out.issues.sort((x, y) => rank[x.severity] - rank[y.severity]);
    return out;
  }

  /**
   * The way back up: every feature that owns this file, and the steps of its verified flow
   * that run through it. With a symbol, only steps naming it or inside its lines count.
   */
  partOf(file: string, symbolId?: string): PartOf {
    const map = loadFeatureMap(this.root);
    const symbol = symbolId ? this.repo.facts.symbols.find((s) => s.id === symbolId) : undefined;
    // A feature counts if it owns the file, or if its verified flow passes through it (shared code
    // belongs to one feature in the map but is used by others).
    const features = (map?.features ?? []).map((f) => {
      const flow = loadAnalysis(this.root, f.id)?.flow ?? [];
      const steps = flow.flatMap((s, index) => {
        const here = symbol
          ? s.symbol === symbol.id || (s.file === file && s.start <= symbol.range.end && s.end >= symbol.range.start)
          : s.file === file;
        return here ? [{ index: index + 1, step: s.step }] : [];
      });
      return { id: f.id, name: f.name, kind: f.kind, steps, owns: f.files.includes(file) };
    }).filter((f) => f.owns || f.steps.length).map(({ owns: _, ...f }) => f);
    // With a symbol, features whose flow actually passes through it come first.
    features.sort((a, b) => b.steps.length - a.steps.length);
    return { features };
  }

  private running() {
    return !!this.job && !this.job.finishedAt;
  }

  /** Stops the running job: Claude sessions in flight are killed, finished features stay saved. */
  cancel(): Job | null {
    if (!this.running() || !this.abort) return this.job;
    this.abort.abort();
    this.job!.cancelled = true;
    this.job!.message = this.job!.kind === "verify" ? `Cancelled after ${this.job!.done.length} of ${this.job!.total}` : "Discovery cancelled";
    this.job!.finishedAt = new Date().toISOString();
    return this.job;
  }

  startDiscovery(): Job {
    if (this.running()) return this.job!;
    const abort = (this.abort = new AbortController());
    const job: Job = { kind: "discover", startedAt: new Date().toISOString(), total: 1, done: [], failed: [], message: "Reading the facts and proposing features" };
    this.job = job;
    void (async () => {
      try {
        const map = await discoverFeatures(pickProvider(), this.repo.facts, this.root, abort.signal);
        saveFeatureMap(this.root, map);
        job.done.push("map");
        job.message = `Proposed ${map.features.length} features`;
      } catch (e) {
        if (abort.signal.aborted) return;
        job.error = (e as Error).message;
        job.message = "Discovery failed";
      } finally {
        job.finishedAt ??= new Date().toISOString();
      }
    })();
    return job;
  }

  startVerify(only?: string): Job {
    if (this.running()) return this.job!;
    const map = loadFeatureMap(this.root);
    const features = (map?.features ?? []).filter((f) => !only || f.id === only);
    const abort = (this.abort = new AbortController());
    const job: Job = { kind: "verify", startedAt: new Date().toISOString(), total: features.length, done: [], failed: [], message: `Verifying ${features.length} features` };
    this.job = job;
    void (async () => {
      try {
        await verifyAll(pickProvider(), this.repo.facts, this.root, features, {
          signal: abort.signal,
          onDone: (id, r) => {
            if (r instanceof Error) job.failed.push({ id, error: r.message });
            else {
              saveAnalysis(this.root, r);
              job.done.push(id);
            }
            if (!abort.signal.aborted) job.message = `Verified ${job.done.length} of ${job.total}`;
          },
        });
      } catch (e) {
        if (!abort.signal.aborted) job.error = (e as Error).message;
      } finally {
        job.finishedAt ??= new Date().toISOString();
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
