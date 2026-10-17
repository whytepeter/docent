import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { redact } from "./redact.ts";
import { parseAnswer } from "./schema.ts";
import { LlmError, type AskOptions, type AskResult, type LlmProvider, type ProviderId } from "./types.ts";

/**
 * What every subscription CLI has in common: find the binary, run it headless in the right folder,
 * hand it a redacted prompt, check what comes back against the Zod schema, and ask once more when
 * the shape is wrong. Each adapter only says which arguments its CLI takes and how to read its output.
 */

/** Whether a CLI is installed and signed in, for Settings and `docent doctor`. */
export interface CliStatus {
  installed: boolean;
  version?: string;
  /** null when the CLI can't say without running a prompt. */
  signedIn: boolean | null;
  /** How it signs in ("ChatGPT", "claude.ai"…), or what's wrong. */
  detail?: string;
}

/** One run of the CLI, as an adapter builds it. */
export interface CliCall {
  args: string[];
  stdin: string;
  cwd: string;
}

/** What an adapter reads out of the CLI's output. */
export interface CliReply {
  /** The structured answer, or the raw text when the CLI has no schema mode. */
  answer: unknown;
  model?: string;
  usage: AskResult<unknown>["usage"];
  /** The CLI reported a failure (not signed in, quota, refusal). */
  error?: string;
}

/** Per-call scratch space under ~/.docent/tmp, never inside the analyzed repo; removed after the call. */
export interface Scratch {
  dir: string;
  write(name: string, content: string): string;
}

const statusCache = new Map<string, { at: number; status: CliStatus }>();

export abstract class HeadlessCli implements LlmProvider {
  abstract readonly id: ProviderId;
  /** "Claude Code", "Codex"… */
  abstract readonly label: string;
  readonly canRead = true;

  constructor(readonly bin: string) {}

  protected abstract build<T extends z.ZodType>(opts: AskOptions<T> & { system: string; prompt: string }, scratch: Scratch): CliCall;
  protected abstract parse(stdout: string, stderr: string): CliReply;
  /** The model name to report when the CLI's output doesn't say. */
  protected abstract defaultModel(opts: AskOptions<z.ZodType>): string;
  /** Runs the CLI's version and login checks. */
  protected abstract probe(): CliStatus;

  /** `probe()`, remembered for 20 seconds: Settings and describe() ask often. */
  status(): CliStatus {
    const hit = statusCache.get(this.bin);
    if (hit && Date.now() - hit.at < 20_000) return hit.status;
    const status = this.probe();
    statusCache.set(this.bin, { at: Date.now(), status });
    return status;
  }
  /** What it runs on, e.g. "your ChatGPT plan". */
  protected abstract plan(): string;

  describe() {
    const s = this.status();
    return `${this.label} (${s.version ?? this.bin}) — uses ${this.plan()}`;
  }

  async ask<T extends z.ZodType>(opts: AskOptions<T>): Promise<AskResult<z.infer<T>>> {
    const started = Date.now();
    if ((opts.tools ?? "none") === "read" && !opts.cwd) throw new LlmError("Reading the repo needs a cwd", this.id);
    const system = redact(opts.system);
    let prompt = redact(opts.prompt);
    const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    // One retry: the second run is told what was wrong with the first answer.
    for (let attempt = 0; ; attempt++) {
      const scratch = makeScratch();
      let reply: CliReply;
      try {
        const call = this.build({ ...opts, system, prompt }, scratch);
        const { stdout, stderr } = await runCli(this.bin, call, opts.signal, this);
        reply = this.parse(stdout, stderr);
      } finally {
        rmSync(scratch.dir, { recursive: true, force: true });
      }
      usage.inputTokens += reply.usage.inputTokens;
      usage.outputTokens += reply.usage.outputTokens;
      usage.cachedTokens += reply.usage.cachedTokens;
      if (reply.error) throw new LlmError(`${this.label} failed: ${reply.error}`, this.id);
      const parsed = parseAnswer(opts.schema, reply.answer);
      if (parsed.ok) {
        return { data: parsed.data, provider: this.id, model: reply.model ?? this.defaultModel(opts), durationMs: Date.now() - started, usage };
      }
      if (attempt >= 1) throw new LlmError(`${this.label}'s answer didn't match the expected shape`, this.id, parsed.issues);
      prompt = `${redact(opts.prompt)}\n\n${retryNote(parsed.issues)}`;
    }
  }
}

export function retryNote(issues: string): string {
  return `Your previous answer didn't match the required JSON schema (${issues}). Answer again: only JSON that matches the schema exactly.`;
}

function makeScratch(): Scratch {
  const root = join(homedir(), ".docent", "tmp");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "llm-"));
  return {
    dir,
    write(name, content) {
      const file = join(dir, name);
      writeFileSync(file, content);
      return file;
    },
  };
}

/** Runs a CLI to completion. Aborting kills it. */
export function runCli(bin: string, call: CliCall, signal: AbortSignal | undefined, who: { id: ProviderId; label: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, call.args, { cwd: call.cwd, stdio: ["pipe", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => reject(signal?.aborted ? new LlmError("Cancelled", who.id) : new LlmError(`Couldn't start ${who.label}: ${e.message}`, who.id)));
    child.on("close", (code) => {
      if (signal?.aborted) return reject(new LlmError("Cancelled", who.id));
      // Some CLIs exit non-zero yet still print a result that says what went wrong; the adapter reads it.
      if (code === 0 || stdout.trim().startsWith("{")) resolve({ stdout, stderr });
      else reject(new LlmError(`${who.label} exited with ${code}`, who.id, (stderr || stdout).slice(-800)));
    });
    child.stdin.on("error", () => {
      /* the CLI may exit before reading stdin; the close handler reports why */
    });
    child.stdin.end(call.stdin);
  });
}

/** Finds a CLI on PATH, or in the usual install folders the server's PATH may lack. */
export function findBinary(name: string, extra: string[] = []): string | null {
  try {
    const found = execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found) return found;
  } catch {
    /* not on PATH */
  }
  const dirs = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".npm-global", "bin"), ...extra];
  return dirs.map((d) => join(d, name)).find((p) => existsSync(p)) ?? null;
}

/** Runs a quick command (version, login status), never throwing. Some CLIs print status to stderr, so both are kept. */
export function quiet(bin: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
