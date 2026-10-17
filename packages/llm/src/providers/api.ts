import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { redact } from "../redact.ts";
import { DEFAULT_MODEL, LlmError, type AskOptions, type AskResult, type LlmProvider } from "../types.ts";

/** The Anthropic API with ANTHROPIC_API_KEY (or an `ant auth login` profile). No file tools: stages put the code in the prompt. */
export class ApiProvider implements LlmProvider {
  readonly id = "api" as const;
  readonly canRead = false;
  private readonly client = new Anthropic();

  describe() {
    return process.env.ANTHROPIC_API_KEY ? "Anthropic API (ANTHROPIC_API_KEY)" : "Anthropic API (ant auth profile)";
  }

  async ask<T extends z.ZodType>(opts: AskOptions<T>): Promise<AskResult<z.infer<T>>> {
    if ((opts.tools ?? "none") === "read") {
      // The API path has no file tools of its own; stages pass the code they need in the prompt.
      throw new LlmError("Reading files directly needs a subscription CLI provider", this.id);
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
