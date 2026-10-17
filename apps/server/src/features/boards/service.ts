import { readdirSync } from "node:fs";
import { join } from "node:path";
import { checkBoard, checkOverview, loadBoard, loadFlows, loadOverview, proposeFlows, saveBoard, saveFlows, saveOverview, writeBoard, writeOverview, type Board, type ProjectOverview } from "@docent/analyze";
import type { BoardState, FlowsState, Job } from "@docent/contracts";
import { repoCacheDir } from "@docent/extract";
import { pickProvider } from "@docent/llm";
import type { RepoService } from "../repo/index.ts";

/** Typical times, for honest estimates (seconds). */
const FLOWS_S = 60;
const BOARD_S = 140;
const CHECK_S = 20;
const OVERVIEW_S = 80;
const OVERVIEW_CHECK_S = 50;

/**
 * Flows and boards, each written in the background. A board shows as soon as it's written; its claims are
 * checked behind it, and the job stays open (stage "Double-checking") until the labels settle.
 */
export class BoardService {
  private flowsJob: Job | null = null;
  private overviewJob: Job | null = null;
  private jobs = new Map<string, Job>();
  private stops = new Map<string, AbortController>();

  constructor(private readonly repo: RepoService) {}

  private get root() {
    return this.repo.root;
  }

  flows(): FlowsState {
    const dir = join(repoCacheDir(this.root), "boards");
    let ready: string[] = [];
    try {
      ready = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    } catch {
      /* no boards yet */
    }
    const flows = loadFlows(this.root);
    const recent = Date.now() - 5 * 60_000;
    const drawing = [...this.jobs.entries()]
      .filter(([, j]) => !j.finishedAt || Date.parse(j.finishedAt) > recent)
      .map(([id, job]) => ({ id, title: flows?.flows.find((f) => f.id === id)?.title ?? id, job }));
    return { flows, job: this.flowsJob, ready, overview: loadOverview(this.root), overviewJob: this.overviewJob, drawing };
  }

  /** Proposes the flows worth a whiteboard (about a minute). */
  proposeFlows(): Job {
    if (this.flowsJob && !this.flowsJob.finishedAt) return this.flowsJob;
    const job: Job = { kind: "flows", startedAt: new Date().toISOString(), total: 1, done: [], failed: [], message: "Finding the flows worth explaining", stage: "Reading the code and finding what it does", estimateSeconds: FLOWS_S };
    this.flowsJob = job;
    void (async () => {
      try {
        const list = await proposeFlows(pickProvider(), this.repo.facts);
        saveFlows(this.root, list);
        job.done.push("flows");
        job.message = `Found ${list.flows.length} flows`;
      } catch (e) {
        job.error = (e as Error).message;
        job.message = "Couldn't find the flows";
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    })();
    return job;
  }

  /** Writes what the project does (about a minute), shows it, then checks its sentences behind it. */
  writeOverview(): Job {
    if (this.overviewJob && !this.overviewJob.finishedAt) return this.overviewJob;
    const job: Job = {
      kind: "overview", startedAt: new Date().toISOString(), total: 2, done: [], failed: [],
      message: "Reading what the project does", stage: "Reading the code to see what it does", estimateSeconds: OVERVIEW_S + OVERVIEW_CHECK_S,
    };
    this.overviewJob = job;
    void (async () => {
      let overview: ProjectOverview | null = null;
      try {
        overview = await writeOverview(pickProvider(), this.repo.facts, this.root);
        saveOverview(this.root, overview);
        job.done.push("overview");
        const elapsed = (Date.now() - Date.parse(job.startedAt)) / 1000;
        Object.assign(job, { stage: "Double-checking every sentence against the code", message: "Overview ready · double-checking", estimateSeconds: elapsed + OVERVIEW_CHECK_S });
        saveOverview(this.root, await checkOverview(pickProvider(), this.repo.facts, this.root, overview));
        job.done.push("check");
        job.message = "Overview ready and checked";
      } catch (e) {
        job.error = (e as Error).message;
        job.message = overview ? "Overview ready; the double-check didn't finish" : "Couldn't write the overview";
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    })();
    return job;
  }

  board(id: string): BoardState | null {
    const flow = loadFlows(this.root)?.flows.find((f) => f.id === id);
    if (!flow) return null;
    return { flow, board: loadBoard(this.root, id), job: this.jobs.get(id) ?? null };
  }

  /** Stops a board that's being drawn. Nothing half-drawn is saved; a board already drawn stays. */
  stopBoard(id: string): Job | null {
    this.stops.get(id)?.abort();
    return this.jobs.get(id) ?? null;
  }

  /** Writes a flow's board (a few minutes), shows it, then checks its claims behind it. */
  writeBoard(id: string): Job {
    const running = this.jobs.get(id);
    if (running && !running.finishedAt) return running;
    const flow = loadFlows(this.root)?.flows.find((f) => f.id === id);
    if (!flow) throw new Error("No such flow");
    const job: Job = {
      kind: "board", featureId: id, startedAt: new Date().toISOString(), total: 2, done: [], failed: [],
      message: `Drawing ${flow.title}`, stage: "Reading the code and drawing the board", active: [flow.title], estimateSeconds: BOARD_S + CHECK_S,
    };
    this.jobs.set(id, job);
    const stop = new AbortController();
    this.stops.set(id, stop);
    const { signal } = stop;
    void (async () => {
      let board: Board | null = null;
      try {
        board = await writeBoard(pickProvider(), this.repo.facts, this.root, flow, { signal });
        saveBoard(this.root, board);
        job.done.push("board");
        const elapsed = (Date.now() - Date.parse(job.startedAt)) / 1000;
        Object.assign(job, { stage: "Double-checking every claim against the code", message: "Board ready · double-checking", estimateSeconds: elapsed + CHECK_S });
        saveBoard(this.root, await checkBoard(pickProvider(), this.repo.facts, this.root, board, { signal }));
        job.done.push("check");
        job.message = "Board ready and checked";
      } catch (e) {
        job.error = (e as Error).message;
        if (signal.aborted) job.error = "Stopped";
        job.message = signal.aborted ? (board ? "Board ready; double-check stopped" : "Stopped") : board ? "Board ready; the double-check didn't finish" : "Couldn't draw the board";
      } finally {
        job.finishedAt = new Date().toISOString();
        job.active = [];
        this.stops.delete(id);
      }
    })();
    return job;
  }
}
