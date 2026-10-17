import { z } from "zod";

/**
 * How Docent reaches a model. One interface (`LlmProvider`), three ways in:
 *  - "claude-code": the user's own Claude Code, headless, on their Claude subscription.
 *  - "codex": the user's own OpenAI Codex CLI, headless, on their ChatGPT plan.
 *  - "api": the Anthropic API with ANTHROPIC_API_KEY (or an `ant auth login` profile).
 * The two CLIs share one base (`HeadlessCli`: spawn, isolation, redaction, schema check and one retry);
 * each adapter only builds its arguments and reads its output.
 * Stages ask for structured output against a Zod schema and never see which one ran.
 */

export * from "./types.ts";
export { HeadlessCli, type CliStatus } from "./cli.ts";
export { ApiProvider } from "./providers/api.ts";
export { ClaudeCodeProvider } from "./providers/claude-code.ts";
export { CodexProvider } from "./providers/codex.ts";
export { chosenProvider, isProviderId, pickProvider, providerStatuses, PROVIDERS, readConfig, writeConfig } from "./registry.ts";
export { z };
export { hasSecret, redact, REDACTED } from "./redact.ts";
export { DOCENT_ENV, loadDocentEnv } from "./secrets.ts";
