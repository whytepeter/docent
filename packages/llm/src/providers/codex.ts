import { homedir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { HeadlessCli, quiet, type CliCall, type CliReply, type CliStatus, type Scratch } from "../cli.ts";
import { extractJson, strictSchema } from "../schema.ts";
import { DOCENT_ENV, SECRET_FILES, SECRET_HOME_DIRS } from "../secrets.ts";
import type { AskOptions, Effort } from "../types.ts";

/** Docent's effort → Codex's `model_reasoning_effort`. "max" isn't offered by every model; xhigh is. */
const EFFORT: Record<Effort, string> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

const PROFILE = "docent-read";

/** Codex features that are on by default and that a read-only explainer must not have. */
const OFF = [
  "hooks", "memories", "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "in_app_browser", "computer_use", "image_generation", "multi_agent", "skill_search", "skill_mcp_dependency_install", "tool_suggest",
  "workspace_dependencies", "worktrees",
];

/**
 * OpenAI Codex CLI, headless (`codex exec`), on the user's ChatGPT plan.
 *
 * Guarantees, all per run and none written to the user's ~/.codex:
 *  - read-only: a permissions profile built on Codex's `:read-only` sandbox, which also has no network.
 *    Codex reads files by running commands (cat, rg, ls…); the OS sandbox stops any of them writing.
 *  - secrets: the repo's `.env*`, key files and agent folders, and the home folders that hold
 *    credentials, are denied to every command.
 *  - isolation: no user config (`--ignore-user-config`), no execpolicy rules, the repo marked untrusted
 *    so its `.codex/` config, hooks and rules are skipped, hooks off, no AGENTS.md, no web search,
 *    no memories, nothing saved (`--ephemeral`, no history).
 *  - shape: `--output-schema` in OpenAI's strict form, then Zod.
 */
export class CodexProvider extends HeadlessCli {
  readonly id = "codex" as const;
  readonly label = "Codex";

  constructor(bin: string, private readonly model?: string) {
    super(bin);
  }

  protected plan() {
    const s = this.status();
    return s.detail?.toLowerCase().includes("api key") ? "your OpenAI API key (set in Codex)" : "your ChatGPT plan";
  }

  protected defaultModel(opts: AskOptions<z.ZodType>) {
    return codexModel(opts.model, this.model) ?? "Codex default";
  }

  protected probe(): CliStatus {
    const version = quiet(this.bin, ["--version"]);
    if (!version.ok) return { installed: false, signedIn: false, detail: version.out.slice(0, 200) };
    const login = quiet(this.bin, ["login", "status"]);
    const line = login.out.split("\n").find((l) => /logged in|not logged/i.test(l))?.trim() ?? login.out.split("\n")[0]?.trim();
    return { installed: true, version: version.out.replace(/^codex-cli\s*/i, "codex "), signedIn: login.ok && !/not logged/i.test(login.out), detail: line };
  }

  protected build<T extends z.ZodType>(opts: AskOptions<T>, scratch: Scratch): CliCall {
    const schemaFile = scratch.write("schema.json", JSON.stringify(strictSchema(opts.schema)));
    const cwd = (opts.tools ?? "none") === "read" && opts.cwd ? opts.cwd : scratch.dir;
    return { args: codexArgs({ ...opts, cwd }, schemaFile, this.model), stdin: codexPrompt(opts.system, opts.prompt, opts.tools ?? "none"), cwd };
  }

  protected parse(stdout: string, stderr: string): CliReply {
    return parseCodex(stdout, stderr);
  }
}

/** A model for Codex: the caller's when it isn't a Claude name, else the one chosen in Settings, else Codex's own default. */
export function codexModel(asked: string | undefined, chosen: string | undefined): string | undefined {
  if (asked && !asked.startsWith("claude")) return asked;
  return chosen || undefined;
}

/** A TOML string (JSON's escaping is a subset TOML basic strings accept). */
const toml = (s: string) => JSON.stringify(s);

/** Arguments for one `codex exec` run. `opts.cwd` is the folder it runs in: the repo, or an empty scratch folder. */
export function codexArgs(opts: AskOptions<z.ZodType> & { cwd: string }, schemaFile: string, chosenModel?: string): string[] {
  const home = homedir();
  const repoRules = SECRET_FILES.map((g) => `${toml(g)}=${toml("deny")}`).join(", ");
  // Outside the repo: credential folders and Docent's own .env. A folder holding the repo itself is left readable.
  const outside = [...SECRET_HOME_DIRS.map((d) => join(home, d)), DOCENT_ENV].filter((p) => !`${opts.cwd}/`.startsWith(`${p}/`));
  const homeRules = outside.map((p) => `${toml(p)}=${toml("deny")}`).join(", ");
  const model = codexModel(opts.model, chosenModel);
  const config = [
    `default_permissions=${toml(PROFILE)}`,
    `permissions.${PROFILE}={extends=${toml(":read-only")}, filesystem={${homeRules}, ${toml(":workspace_roots")}={${repoRules}}}}`,
    `projects={${toml(opts.cwd)}={trust_level=${toml("untrusted")}}}`,
    `approval_policy=${toml("never")}`,
    // Everything that could reach outside the folder or act: connectors, browsers, computer use, plugins, sub-agents.
    ...OFF.map((f) => `features.${f}=false`),
    // With nothing to read, no shell either: the model can only answer.
    ...(opts.tools === "read" ? [] : ["features.shell_tool=false", "features.unified_exec=false"]),
    "project_doc_max_bytes=0",
    `web_search=${toml("disabled")}`,
    `history.persistence=${toml("none")}`,
    `shell_environment_policy.inherit=${toml("core")}`,
    "check_for_update_on_startup=false",
    ...(opts.effort ? [`model_reasoning_effort=${toml(EFFORT[opts.effort])}`] : []),
  ];
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--color", "never",
    "--cd", opts.cwd,
    "--output-schema", schemaFile,
    ...(model ? ["--model", model] : []),
    ...config.flatMap((c) => ["-c", c]),
    "-", // the prompt comes on stdin
  ];
}

/**
 * Codex has no system-prompt flag that keeps its own tool instructions, so Docent's instructions lead the
 * prompt. With no repo to read, it's told so (it runs in an empty folder anyway).
 */
export function codexPrompt(system: string, prompt: string, tools: "none" | "read"): string {
  const reading = tools === "read"
    ? "You may read files in the current folder (read-only commands such as cat, sed -n, rg, ls). Never try to change anything."
    : "Answer from this message only. Don't run commands or read files.";
  return `<instructions>\n${system}\n\n${reading} Your final message must be only the JSON answer.\n</instructions>\n\n${prompt}`;
}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
  error?: { message?: string } | string;
  message?: string;
  model?: string;
}

/** Reads `codex exec --json` (JSON Lines): the last agent message is the answer, `turn.completed` has the usage. */
export function parseCodex(stdout: string, stderr = ""): CliReply {
  let text: string | undefined;
  let error: string | undefined;
  let model: string | undefined;
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let e: CodexEvent;
    try {
      e = JSON.parse(line) as CodexEvent;
    } catch {
      continue;
    }
    if (e.model) model = e.model;
    if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") text = e.item.text;
    if (e.type === "turn.completed" && e.usage) {
      usage.inputTokens += e.usage.input_tokens ?? 0;
      usage.outputTokens += (e.usage.output_tokens ?? 0) + (e.usage.reasoning_output_tokens ?? 0);
      usage.cachedTokens += e.usage.cached_input_tokens ?? 0;
    }
    if (e.type === "turn.failed" || e.type === "error") {
      error = typeof e.error === "string" ? e.error : e.error?.message ?? e.message ?? "unknown error";
    }
  }
  if (text === undefined && !error) error = (stderr.trim().split("\n").slice(-3).join(" ") || "no answer").slice(0, 400);
  return { answer: text === undefined ? undefined : extractJson(text), ...(model ? { model } : {}), usage, ...(error && text === undefined ? { error } : {}) };
}
