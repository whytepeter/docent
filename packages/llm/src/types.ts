import type { z } from "zod";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AskOptions<T extends z.ZodType> {
  system: string;
  prompt: string;
  schema: T;
  /** "none": answer from the prompt only. "read": may read files under `cwd` (never write, never run). */
  tools?: "none" | "read";
  /** Repo root; required when tools are "read". */
  cwd?: string;
  /** A model name for this provider. A Claude model name is ignored by the other providers. */
  model?: string;
  effort?: Effort;
  signal?: AbortSignal;
}

export interface AskResult<T> {
  data: T;
  provider: ProviderId;
  model: string;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

/** Subscription CLIs first ("claude-code", "codex"), then the Anthropic API with a key. */
export type ProviderId = "claude-code" | "codex" | "api";

export interface LlmProvider {
  id: ProviderId;
  /** Whether `tools: "read"` works: the provider can open files under `cwd`, read-only. */
  readonly canRead: boolean;
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
