import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { redact } from "./redact.ts";

/**
 * How Docent talks to Claude. Two ways in, one interface:
 *  - "claude-code": drives the user's own Claude Code CLI headlessly, so it runs on their
 *    Claude subscription (Pro/Max) with no API key.
 *  - "api": the Anthropic API with ANTHROPIC_API_KEY (or an `ant auth login` profile).
 * Stages ask for structured output against a Zod schema and never see which one ran.
 */

export interface AskOptions<T extends z.ZodType> {
  system: string;
  prompt: string;
  schema: T;
  /** "none": answer from the prompt only. "read": may read files under `cwd` (never write, never run). */
  tools?: "none" | "read";
  /** Repo root; required when tools are "read". */
  cwd?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  signal?: AbortSignal;
}

export interface AskResult<T> {
  data: T;
  provider: ProviderId;
  model: string;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

export type ProviderId = "claude-code" | "api";

export interface LlmProvider {
  id: ProviderId;
  /** A one-line description for `docent doctor` and the app's settings. */
  describe(): string;
  ask<T extends z.ZodType>(opts: AskOptions<T>): Promise<AskResult<z.infer<T>>>;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

export class LlmError extends Error {
  constructor(message: string, readonly provider: ProviderId, readonly detail?: string) {
    super(message);
    this.name = "LlmError";
  }
}

// ---------------------------------------------------------------- claude-code (subscription)

const READ_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Files the session may never open, by Read, Grep or Glob: secret-bearing files, and agent session folders,
 * which are full of pasted keys and tokens and would reach Claude unredacted.
 */
const SECRET_FILES = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa*", "**/id_ed25519*", "**/.npmrc", "**/.netrc",
  "**/.wolf/**", "**/.claude/**", "**/.cursor/**", "**/.codex/**", "**/.agents/**",
];

/**
 * The analyzed repo is someone else's code, so the session ignores every settings source:
 * no hooks (the repo's or the user's) that could run commands or write into the repo,
 * no CLAUDE.md or rules steering the answer, no MCP servers, no skills.
 */
const ISOLATION = [
  "--setting-sources", "",
  "--settings", JSON.stringify({ disableAllHooks: true, permissions: { deny: SECRET_FILES.map((p) => `Read(${p})`) } }),
  "--strict-mcp-config",
  "--disable-slash-commands",
];

function claudeBinary(): string | null {
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || null;
  } catch {
    const local = join(homedir(), ".local", "bin", "claude");
    return existsSync(local) ? local : null;
  }
}

export class ClaudeCodeProvider implements LlmProvider {
  readonly id = "claude-code" as const;
  constructor(private readonly bin: string) {}

  describe() {
    let version = "";
    try {
      version = execFileSync(this.bin, ["--version"], { encoding: "utf8" }).trim();
    } catch {
      /* reported by ask() if it really fails */
    }
    return `Claude Code (${version || this.bin}) — uses your Claude subscription`;
  }

  async ask<T extends z.ZodType>(opts: AskOptions<T>): Promise<AskResult<z.infer<T>>> {
    const started = Date.now();
    const tools = opts.tools ?? "none";
    if (tools === "read" && !opts.cwd) throw new LlmError("Reading the repo needs a cwd", this.id);
    const args = [
      "-p",
      "--output-format", "json",
      "--no-session-persistence",
      "--model", opts.model ?? DEFAULT_MODEL,
      "--system-prompt", redact(opts.system),
      "--json-schema", JSON.stringify(jsonSchema(opts.schema)),
      ...ISOLATION,
      // Only read-only tools exist in the session; nothing can edit files or run commands.
      "--tools", tools === "read" ? READ_TOOLS.join(",") : "",
      ...(tools === "read" ? ["--allowedTools", ...READ_TOOLS, "--permission-mode", "dontAsk"] : []),
      ...(opts.effort ? ["--effort", opts.effort] : []),
    ];
    const raw = await run(this.bin, args, redact(opts.prompt), opts.cwd, opts.signal);
    let out: ClaudeCodeResult;
    try {
      out = JSON.parse(raw) as ClaudeCodeResult;
    } catch {
      throw new LlmError("Claude Code returned something that isn't JSON", this.id, raw.slice(0, 400));
    }
    if (out.is_error) throw new LlmError(`Claude Code failed: ${out.result ?? out.subtype ?? "unknown error"}`, this.id, raw.slice(0, 400));
    const parsed = opts.schema.safeParse(out.structured_output);
    if (!parsed.success) throw new LlmError("Claude's answer didn't match the expected shape", this.id, parsed.error.message);
    const model = Object.keys(out.modelUsage ?? {})[0] ?? opts.model ?? DEFAULT_MODEL;
    return {
      data: parsed.data,
      provider: this.id,
      model,
      durationMs: Date.now() - started,
      usage: {
        inputTokens: out.usage?.input_tokens ?? 0,
        outputTokens: out.usage?.output_tokens ?? 0,
        cachedTokens: (out.usage?.cache_read_input_tokens ?? 0) + (out.usage?.cache_creation_input_tokens ?? 0),
      },
    };
  }
}

/** Claude Code validates `--json-schema` as draft-07 and rejects the 2020-12 `$schema` marker Zod emits by default. */
function jsonSchema(schema: z.ZodType): object {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return rest;
}

interface ClaudeCodeResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

function run(bin: string, args: string[], stdin: string, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], signal });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(signal?.aborted ? new LlmError("Cancelled", "claude-code") : new LlmError(`Couldn't start Claude Code: ${e.message}`, "claude-code")));
    child.on("close", (code) => {
      if (signal?.aborted) return reject(new LlmError("Cancelled", "claude-code"));
      if (code === 0 || out.trim().startsWith("{")) resolve(out);
      else reject(new LlmError(`Claude Code exited with ${code}`, "claude-code", (err || out).slice(0, 600)));
    });
    child.stdin.end(stdin);
  });
}

// ---------------------------------------------------------------- api (API key or ant profile)

export class ApiProvider implements LlmProvider {
  readonly id = "api" as const;
  private readonly client = new Anthropic();

  describe() {
    return process.env.ANTHROPIC_API_KEY ? "Anthropic API (ANTHROPIC_API_KEY)" : "Anthropic API (ant auth profile)";
  }

  async ask<T extends z.ZodType>(opts: AskOptions<T>): Promise<AskResult<z.infer<T>>> {
    if ((opts.tools ?? "none") === "read") {
      // The API path has no file tools of its own; stages pass the code they need in the prompt.
      throw new LlmError("Reading files directly needs the Claude Code provider", this.id);
    }
    const started = Date.now();
    const model = opts.model ?? DEFAULT_MODEL;
    const response = await this.client.messages.parse(
      {
        model,
        max_tokens: 16000,
        system: redact(opts.system),
        messages: [{ role: "user", content: redact(opts.prompt) }],
        output_config: { format: zodOutputFormat(opts.schema as z.ZodType<object>), ...(opts.effort ? { effort: opts.effort } : {}) },
      },
      { signal: opts.signal },
    );
    if (response.stop_reason === "refusal") throw new LlmError("Claude declined this request", this.id);
    if (!response.parsed_output) throw new LlmError("Claude's answer didn't match the expected shape", this.id);
    return {
      data: response.parsed_output as z.infer<T>,
      provider: this.id,
      model: response.model,
      durationMs: Date.now() - started,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}

// ---------------------------------------------------------------- choosing

interface Config {
  provider?: ProviderId;
  model?: string;
}

export function readConfig(): Config & Record<string, unknown> {
  const file = join(homedir(), ".docent", "config.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Config & Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Writes ~/.docent/config.json, keeping keys this package doesn't know (the voice settings live there too). */
export function writeConfig(config: Config & Record<string, unknown>): void {
  const dir = join(homedir(), ".docent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Picks how to reach Claude. A subscription through Claude Code is preferred when it's installed;
 * the API is used when asked for in ~/.docent/config.json or DOCENT_PROVIDER, or when Claude Code is missing.
 */
export function pickProvider(): LlmProvider {
  const wanted = (process.env.DOCENT_PROVIDER as ProviderId | undefined) ?? readConfig().provider;
  const bin = claudeBinary();
  if (wanted === "api") return new ApiProvider();
  if (bin) return new ClaudeCodeProvider(bin);
  if (wanted === "claude-code") throw new LlmError("Claude Code isn't installed. Install it, then run `claude` once to sign in.", "claude-code");
  return new ApiProvider();
}

export { z };
export { hasSecret, redact, REDACTED } from "./redact.ts";
