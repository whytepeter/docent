import type { z } from "zod";
import { HeadlessCli, quiet, type CliCall, type CliReply, type CliStatus, type Scratch } from "../cli.ts";
import { draft7 } from "../schema.ts";
import { SECRET_FILES } from "../secrets.ts";
import { DEFAULT_MODEL, type AskOptions } from "../types.ts";

const READ_TOOLS = ["Read", "Grep", "Glob"];

/**
 * The analyzed repo is someone else's code, so the session ignores every settings source:
 * no hooks (the repo's or the user's) that could run commands or write into the repo,
 * no CLAUDE.md or rules steering the answer, no MCP servers, no skills.
 */
export const ISOLATION = [
  "--setting-sources", "",
  "--settings", JSON.stringify({ disableAllHooks: true, permissions: { deny: SECRET_FILES.map((p) => `Read(${p})`) } }),
  "--strict-mcp-config",
  "--disable-slash-commands",
];

/** Claude Code, headless (`claude -p`), on the user's Claude subscription. Schema-enforced output via `--json-schema`. */
export class ClaudeCodeProvider extends HeadlessCli {
  readonly id = "claude-code" as const;
  readonly label = "Claude Code";

  protected plan() {
    return "your Claude subscription";
  }

  protected defaultModel(opts: AskOptions<z.ZodType>) {
    return opts.model ?? DEFAULT_MODEL;
  }

  protected probe(): CliStatus {
    const version = quiet(this.bin, ["--version"]);
    if (!version.ok) return { installed: false, signedIn: false, detail: version.out.slice(0, 200) };
    const auth = quiet(this.bin, ["auth", "status"]);
    try {
      const s = JSON.parse(auth.out) as { loggedIn?: boolean; authMethod?: string };
      return { installed: true, version: version.out.replace(/\s*\(Claude Code\)$/, ""), signedIn: !!s.loggedIn, detail: s.authMethod };
    } catch {
      return { installed: true, version: version.out.replace(/\s*\(Claude Code\)$/, ""), signedIn: null };
    }
  }

  protected build<T extends z.ZodType>(opts: AskOptions<T>, _scratch: Scratch): CliCall {
    return { args: claudeArgs(opts), stdin: opts.prompt, cwd: opts.cwd ?? _scratch.dir };
  }

  protected parse(stdout: string): CliReply {
    return parseClaude(stdout);
  }
}

/** Arguments for one `claude -p` run. `opts.system` and `opts.prompt` are already redacted. */
export function claudeArgs(opts: AskOptions<z.ZodType>): string[] {
  const read = (opts.tools ?? "none") === "read";
  return [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--model", opts.model ?? DEFAULT_MODEL,
    "--system-prompt", opts.system,
    "--json-schema", JSON.stringify(draft7(opts.schema)),
    ...ISOLATION,
    // Only read-only tools exist in the session; nothing can edit files or run commands.
    "--tools", read ? READ_TOOLS.join(",") : "",
    ...(read ? ["--allowedTools", ...READ_TOOLS, "--permission-mode", "dontAsk"] : []),
    ...(opts.effort ? ["--effort", opts.effort] : []),
  ];
}

interface ClaudeCodeResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

export function parseClaude(stdout: string): CliReply {
  let out: ClaudeCodeResult;
  try {
    out = JSON.parse(stdout) as ClaudeCodeResult;
  } catch {
    return { answer: undefined, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, error: `returned something that isn't JSON: ${stdout.slice(0, 200)}` };
  }
  return {
    answer: out.structured_output,
    model: Object.keys(out.modelUsage ?? {})[0],
    usage: {
      inputTokens: out.usage?.input_tokens ?? 0,
      outputTokens: out.usage?.output_tokens ?? 0,
      cachedTokens: (out.usage?.cache_read_input_tokens ?? 0) + (out.usage?.cache_creation_input_tokens ?? 0),
    },
    ...(out.is_error ? { error: out.result ?? out.subtype ?? "unknown error" } : {}),
  };
}
