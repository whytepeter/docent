import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findBinary, type CliStatus, type HeadlessCli } from "./cli.ts";
import { ApiProvider } from "./providers/api.ts";
import { ClaudeCodeProvider } from "./providers/claude-code.ts";
import { CodexProvider } from "./providers/codex.ts";
import { LlmError, type LlmProvider, type ProviderId } from "./types.ts";

interface Config {
  provider?: ProviderId;
  /** Legacy: one model for every provider. */
  model?: string;
  /** A model per provider, e.g. { codex: "gpt-5.5" }. Unset means the CLI's own default. */
  models?: Partial<Record<ProviderId, string>>;
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

/** Every way Docent can reach a model, in the order Settings lists them. */
export const PROVIDERS: { id: ProviderId; name: string; vendor: string; plan: string; account?: string; bin?: string; install?: string; signIn?: string; docs: string }[] = [
  {
    id: "claude-code", name: "Claude Code", vendor: "Anthropic", plan: "Claude Pro or Max", account: "Claude", bin: "claude",
    install: "curl -fsSL https://claude.ai/install.sh | bash", signIn: "claude", docs: "https://docs.claude.com/en/docs/claude-code/setup",
  },
  {
    id: "codex", name: "Codex", vendor: "OpenAI", plan: "ChatGPT Plus, Pro, Business or Enterprise", account: "ChatGPT", bin: "codex",
    install: "npm install -g @openai/codex", signIn: "codex login", docs: "https://developers.openai.com/codex/cli",
  },
  { id: "api", name: "Anthropic API key", vendor: "Anthropic", plan: "pay per use", docs: "https://console.anthropic.com/settings/keys" },
];

export const isProviderId = (p: unknown): p is ProviderId => typeof p === "string" && PROVIDERS.some((x) => x.id === p);

function cli(id: ProviderId): HeadlessCli | null {
  const config = readConfig();
  if (id === "claude-code") {
    const bin = findBinary("claude");
    return bin ? new ClaudeCodeProvider(bin) : null;
  }
  if (id === "codex") {
    const bin = findBinary("codex");
    return bin ? new CodexProvider(bin, config.models?.codex) : null;
  }
  return null;
}

/** Whether each subscription CLI is installed and signed in. Runs `--version` and the login check of each. */
export function providerStatuses(): (typeof PROVIDERS[number] & CliStatus)[] {
  return PROVIDERS.map((p) => {
    if (p.id === "api") return { ...p, installed: true, signedIn: !!process.env.ANTHROPIC_API_KEY };
    const c = cli(p.id);
    return { ...p, ...(c ? c.status() : { installed: false, signedIn: false }) };
  });
}

/** The provider chosen in DOCENT_PROVIDER or ~/.docent/config.json, if any. */
export function chosenProvider(): ProviderId | undefined {
  const wanted = process.env.DOCENT_PROVIDER ?? readConfig().provider;
  return isProviderId(wanted) ? wanted : undefined;
}

/**
 * Picks how to reach a model. The one chosen in DOCENT_PROVIDER or ~/.docent/config.json wins, and a missing
 * CLI is an error that says how to install it. With no choice: Claude Code, then Codex, then the API.
 */
export function pickProvider(): LlmProvider {
  const wanted = chosenProvider();
  if (wanted === "api") return new ApiProvider();
  if (wanted) {
    const c = cli(wanted);
    if (c) return c;
    const p = PROVIDERS.find((x) => x.id === wanted)!;
    throw new LlmError(`${p.name} isn't installed. Install it with \`${p.install}\`, then run \`${p.signIn}\` once to sign in.`, wanted);
  }
  return cli("claude-code") ?? cli("codex") ?? new ApiProvider();
}
