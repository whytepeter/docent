import { readdirSync } from "node:fs";
import { join } from "node:path";
import { checkBoard, checkOverview, freshness, loadBoard, loadFlows, loadOverview, proposeFlows, refreshBoard, saveBoard, saveFlows, saveOverview, updateBoard, writeBoard, writeOverview, type Board, type ProjectOverview } from "@docent/analyze";
import type { BoardState, FlowsState, Job } from "@docent/contracts";
import { repoCacheDir } from "@docent/extract";
import { pickProvider } from "@docent/llm";
import type { RepoService } from "../repo/index.ts";

/** Typical times, for honest estimates (seconds). */
const FLOWS_S = 60;
const BOARD_S = 140;
const UPDATE_S = 60;
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
    // Reading a few excerpts per board is quick; a board whose code only moved isn't stale (it's fixed when opened).
    const stale = ready.filter((id) => {
      const b = loadBoard(this.root, id);
      const s = b ? freshness(b, this.repo.facts, this.root).state : "fresh";
      return s === "changed" || s === "redraw";
    });
    return { flows, job: this.flowsJob, ready, overview: loadOverview(this.root), overviewJob: this.overviewJob, drawing, stale };
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
    let board = loadBoard(this.root, id);
    let fresh = board ? freshness(board, this.repo.facts, this.root) : null;
    // Code that only moved is fixed here, with no AI: same words, lines shifted to where the code is now.
    if (board && fresh?.state === "moved") {
      board = refreshBoard(board, fresh, this.repo.facts, this.root);
      saveBoard(this.root, board);
      fresh = freshness(board, this.repo.facts, this.root);
    }
    return { flow, board, job: this.jobs.get(id) ?? null, fresh };
  }

  /** Stops a board that's being drawn. Nothing half-drawn is saved; a board already drawn stays. */
  stopBoard(id: string): Job | null {
    this.stops.get(id)?.abort();
    return this.jobs.get(id) ?? null;
  }

  /**
   * Writes a flow's board (a few minutes), shows it, then checks its claims behind it. "update" rewrites only the
   * cards whose code changed (and what depends on them), keeping the rest word for word; it falls back to drawing
   * the board again when there's nothing to update from. The board already on disk stays until the new one is saved.
   */
  async writeBoard(id: string, mode: "draw" | "update" = "draw"): Promise<Job> {
    const running = this.jobs.get(id);
    if (running && !running.finishedAt) return running;
    const flow = loadFlows(this.root)?.flows.find((f) => f.id === id);
    if (!flow) throw new Error("No such flow");
    // The facts (call graph, tests, symbols) must describe the code as it is now.
    if (this.repo.isStale()) await this.repo.reextract();
    const old = mode === "update" ? loadBoard(this.root, id) : null;
    const changed = old ? freshness(old, this.repo.facts, this.root).cards.filter((c) => c.state === "changed").map((c) => c.id) : [];
    const updating = !!old && changed.length > 0;
    const job: Job = {
      kind: "board", featureId: id, startedAt: new Date().toISOString(), total: 2, done: [], failed: [],
      message: updating ? `Updating ${flow.title}` : `Drawing ${flow.title}`,
      stage: updating ? `Rewriting ${changed.length === 1 ? "the card" : `${changed.length} cards`} whose code changed` : "Reading the code and drawing the board",
      active: [flow.title], estimateSeconds: (updating ? UPDATE_S : BOARD_S) + CHECK_S,
    };
    this.jobs.set(id, job);
    const stop = new AbortController();
    this.stops.set(id, stop);
    const { signal } = stop;
    void (async () => {
      let board: Board | null = null;
      try {
        board = updating
          ? await updateBoard(pickProvider(), this.repo.facts, this.root, flow, old!, changed, { signal })
          : await writeBoard(pickProvider(), this.repo.facts, this.root, flow, { signal });
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
