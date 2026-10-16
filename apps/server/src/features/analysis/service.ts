import {
  discoverFeatures, filesHash, listAnalyses, loadAnalysis, loadEpisode, loadFeatureMap, saveAnalysis, saveEpisode, saveFeatureMap, verifyAll, writeEpisode,
  type Feature, type FeatureMap,
} from "@docent/analyze";
import type { AnalysisHealth, EpisodeState, FeatureCard, FeaturesState, Job, PartOf } from "@docent/contracts";
import { pickProvider } from "@docent/llm";
import type { RepoService } from "../repo/index.ts";

/** Typical times, for estimates before real progress refines them (seconds). */
const DISCOVER_S = 75;
const VERIFY_S = 150;
const EPISODE_S = 190;
const CONCURRENCY = 3;
const DEFAULT_FEATURES = 12;
const waves = (n: number) => Math.ceil(n / CONCURRENCY);

/**
 * Discovery and verification as background jobs, one at a time. The app polls the job;
 * results land in the repo's cache as each feature finishes.
 */
export class AnalysisService {
  private job: Job | null = null;
  private abort: AbortController | null = null;
  private episodeJob: Job | null = null;
  private episodeAbort: AbortController | null = null;

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
    return { map, cards, job: this.job, episodeJob: this.episodeJob, provider, links };
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
  /**
   * Writes a feature's episode in the background. It has its own lane, so watching a feature never waits
   * behind the job that's getting the rest of the codebase ready.
   */
  startEpisode(id: string): Job {
    if (this.episodeJob && !this.episodeJob.finishedAt) return this.episodeJob;
    const feature = loadFeatureMap(this.root)?.features.find((f) => f.id === id);
    const analysis = loadAnalysis(this.root, id);
    if (!feature || !analysis) throw new Error("This feature hasn't been checked yet");
    const abort = (this.episodeAbort = new AbortController());
    const job: Job = {
      kind: "episode", featureId: id, startedAt: new Date().toISOString(), total: 1, done: [], failed: [],
      message: `Writing the episode for ${feature.name}`, stage: "Writing the lesson from what was checked", active: [feature.name], estimateSeconds: EPISODE_S,
    };
    this.episodeJob = job;
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
        job.active = [];
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

  /** Stops the running work: Claude sessions in flight are killed, features already finished stay saved. */
  cancel(): Job | null {
    for (const [job, abort] of [[this.episodeJob, this.episodeAbort], [this.job, this.abort]] as const) {
      if (!job || job.finishedAt || !abort) continue;
      abort.abort();
      job.cancelled = true;
      job.active = [];
      job.message = job.kind === "episode" ? "Stopped writing the episode" : job.done.length ? `Stopped · ${job.done.length} of ${job.total} ready` : "Stopped";
      job.finishedAt = new Date().toISOString();
    }
    return this.job;
  }

  /** A feature is ready when it was checked against this code and went through the second reader. */
  private ready(feature: Feature): boolean {
    const a = loadAnalysis(this.root, feature.id);
    return !!a && a.filesHash === filesHash(this.repo.facts, feature.files) && a.claims.some((c) => c.review);
  }

  /**
   * The one thing a newcomer has to do: find the features (if that hasn't happened) and check every one that
   * isn't ready, a few at a time. Each feature can be explored as soon as it's done.
   */
  startPrepare(): Job {
    if (this.running()) return this.job!;
    const abort = (this.abort = new AbortController());
    const existing = loadFeatureMap(this.root);
    const pending = existing?.features.filter((f) => !this.ready(f)) ?? [];
    const job: Job = {
      kind: "prepare", startedAt: new Date().toISOString(), total: existing ? pending.length : 0, done: [], failed: [],
      message: existing ? "Checking each feature against the code" : "Finding what this codebase does",
      stage: existing ? "Checking each feature against the code" : "Reading the code and finding its features",
      active: [], estimateSeconds: (existing ? 0 : DISCOVER_S) + waves(existing ? pending.length : DEFAULT_FEATURES) * VERIFY_S,
    };
    this.job = job;
    void (async () => {
      try {
        let features = pending;
        if (!existing) {
          const map = await discoverFeatures(pickProvider(), this.repo.facts, this.root, abort.signal);
          saveFeatureMap(this.root, map);
          features = map.features;
          const elapsed = (Date.now() - Date.parse(job.startedAt)) / 1000;
          Object.assign(job, { total: features.length, stage: "Checking each feature against the code", message: `Found ${features.length} features`, estimateSeconds: elapsed + waves(features.length) * VERIFY_S });
        }
        await this.verifyInto(job, features, abort);
        if (!abort.signal.aborted) {
          job.message = !job.total ? "Everything is already ready"
            : job.failed.length ? `${job.done.length} of ${job.total} ready · ${job.failed.length} couldn't be checked`
            : `All ${job.total} features ready`;
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        job.error = (e as Error).message;
        job.message = "Couldn't finish getting the codebase ready";
      } finally {
        job.finishedAt ??= new Date().toISOString();
        job.active = [];
      }
    })();
    return job;
  }

  startDiscovery(): Job {
    if (this.running()) return this.job!;
    const abort = (this.abort = new AbortController());
    const job: Job = { kind: "discover", startedAt: new Date().toISOString(), total: 1, done: [], failed: [], message: "Finding what this codebase does", stage: "Reading the code and finding its features", estimateSeconds: DISCOVER_S };
    this.job = job;
    void (async () => {
      try {
        const map = await discoverFeatures(pickProvider(), this.repo.facts, this.root, abort.signal);
        saveFeatureMap(this.root, map);
        job.done.push("map");
        job.message = `Found ${map.features.length} features`;
      } catch (e) {
        if (abort.signal.aborted) return;
        job.error = (e as Error).message;
        job.message = "Couldn't find the features";
      } finally {
        job.finishedAt ??= new Date().toISOString();
      }
    })();
    return job;
  }

  /** Check one feature again (or every feature): the same work as preparing, without finding features. */
  startVerify(only?: string): Job {
    if (this.running()) return this.job!;
    const map = loadFeatureMap(this.root);
    const features = (map?.features ?? []).filter((f) => !only || f.id === only);
    const abort = (this.abort = new AbortController());
    const job: Job = {
      kind: "verify", startedAt: new Date().toISOString(), total: features.length, done: [], failed: [],
      message: features.length === 1 ? `Checking ${features[0]!.name}` : `Checking ${features.length} features`,
      stage: "Checking against the code", active: [], estimateSeconds: waves(features.length) * VERIFY_S,
    };
    this.job = job;
    void (async () => {
      try {
        await this.verifyInto(job, features, abort);
        if (!abort.signal.aborted) job.message = features.length === 1 ? (job.done.length ? "Ready" : "Couldn't check it") : `${job.done.length} of ${job.total} ready`;
      } catch (e) {
        if (!abort.signal.aborted) job.error = (e as Error).message;
      } finally {
        job.finishedAt ??= new Date().toISOString();
        job.active = [];
      }
    })();
    return job;
  }

  /** Runs verification, keeping the job's in-flight names, progress and time estimate current. */
  private async verifyInto(job: Job, features: Feature[], abort: AbortController): Promise<void> {
    const names = new Map(features.map((f) => [f.id, f.name]));
    const began = Date.now();
    await verifyAll(pickProvider(), this.repo.facts, this.root, features, {
      signal: abort.signal,
      onStart: (id) => {
        if (!abort.signal.aborted) job.active = [...(job.active ?? []), names.get(id) ?? id];
      },
      onDone: (id, r) => {
        job.active = (job.active ?? []).filter((n) => n !== names.get(id));
        if (r instanceof Error) job.failed.push({ id, error: r.message });
        else {
          saveAnalysis(this.root, r);
          job.done.push(id);
        }
        if (abort.signal.aborted) return;
        // Refine the estimate from the real pace so far.
        const finished = job.done.length + job.failed.length;
        const perFeature = (Date.now() - began) / 1000 / finished;
        const elapsed = (Date.now() - Date.parse(job.startedAt)) / 1000;
        job.estimateSeconds = Math.round(elapsed + (features.length - finished) * perFeature);
        job.message = `${job.done.length} of ${job.total} ready`;
      },
    });
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
