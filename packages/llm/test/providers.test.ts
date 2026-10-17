import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { HeadlessCli, type CliCall, type CliReply, type CliStatus } from "../src/cli.ts";
import { claudeArgs, ISOLATION, parseClaude } from "../src/providers/claude-code.ts";
import { codexArgs, codexModel, codexPrompt, parseCodex } from "../src/providers/codex.ts";
import { dropOptionalNulls, draft7, extractJson, parseAnswer, strictSchema } from "../src/schema.ts";
import type { AskOptions, ProviderId } from "../src/types.ts";

const Schema = z.object({ title: z.string().min(1), steps: z.array(z.object({ n: z.number().int(), note: z.string().optional() })), why: z.string().nullable() });
const opts = (o: Partial<AskOptions<typeof Schema>> = {}): AskOptions<typeof Schema> => ({ system: "be exact", prompt: "explain", schema: Schema, ...o });
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("Claude Code arguments", () => {
  it("isolates the session and allows only read tools when reading", () => {
    const args = claudeArgs(opts({ tools: "read", cwd: "/repo", effort: "high" }));
    for (const f of ISOLATION) expect(args).toContain(f);
    expect(after(args, "--tools")).toBe("Read,Grep,Glob");
    expect(after(args, "--permission-mode")).toBe("dontAsk");
    expect(after(args, "--effort")).toBe("high");
    expect(JSON.parse(after(args, "--json-schema")!)).not.toHaveProperty("$schema");
    expect(JSON.parse(after(args, "--settings")!).permissions.deny).toContain("Read(**/.env)");
  });
  it("has no tools at all without reading", () => {
    const args = claudeArgs(opts());
    expect(after(args, "--tools")).toBe("");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--effort");
  });
});

describe("Claude Code output", () => {
  it("reads the structured answer, model and usage", () => {
    const r = parseClaude(JSON.stringify({ structured_output: { ok: true }, modelUsage: { "claude-opus-5-5": {} }, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }));
    expect(r).toMatchObject({ answer: { ok: true }, model: "claude-opus-5-5", usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 5 } });
    expect(r.error).toBeUndefined();
  });
  it("reports a failed run and output that isn't JSON", () => {
    expect(parseClaude(JSON.stringify({ is_error: true, result: "Not logged in" })).error).toBe("Not logged in");
    expect(parseClaude("oops").error).toMatch(/isn't JSON/);
  });
});

describe("Codex arguments", () => {
  const read = codexArgs({ ...opts({ tools: "read", effort: "max" }), cwd: "/work/repo" }, "/tmp/s.json");
  const config = read.filter((_, i) => read[i - 1] === "-c");

  it("runs exec read-only, ephemeral, without user config, rules, hooks or AGENTS.md", () => {
    expect(read[0]).toBe("exec");
    for (const f of ["--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) expect(read).toContain(f);
    expect(after(read, "--cd")).toBe("/work/repo");
    expect(after(read, "--output-schema")).toBe("/tmp/s.json");
    expect(read).not.toContain("--sandbox"); // the permissions profile replaces it; Codex refuses both
    expect(config).toContain('default_permissions="docent-read"');
    expect(config.find((c) => c.startsWith("permissions.docent-read="))).toContain('extends=":read-only"');
    expect(config).toContain("features.hooks=false");
    expect(config).toContain("project_doc_max_bytes=0");
    expect(config).toContain('web_search="disabled"');
    expect(config).toContain('history.persistence="none"');
    expect(config).toContain('projects={"/work/repo"={trust_level="untrusted"}}');
    expect(read.at(-1)).toBe("-");
  });
  it("denies secrets in the repo and credential folders outside it", () => {
    const profile = config.find((c) => c.startsWith("permissions.docent-read="))!;
    expect(profile).toContain('"**/.env"="deny"');
    expect(profile).toContain('"**/.codex/**"="deny"');
    expect(profile).toContain(`${JSON.stringify(join(homedir(), ".ssh"))}="deny"`);
    expect(profile).toMatch(/\.env"="deny"/);
  });
  it("leaves a credential-named folder readable when the repo is inside it", () => {
    const inside = codexArgs({ ...opts({ tools: "read" }), cwd: join(homedir(), ".docker", "proj") }, "/s.json");
    expect(inside.find((c) => c.startsWith("permissions."))).not.toContain(JSON.stringify(join(homedir(), ".docker")));
  });
  it("maps effort, and caps max at xhigh", () => {
    expect(config).toContain('model_reasoning_effort="xhigh"');
    const low = codexArgs({ ...opts({ effort: "low" }), cwd: "/s" }, "/s.json");
    expect(low).toContain('model_reasoning_effort="low"');
  });
  it("ignores a Claude model name and uses the one chosen for Codex", () => {
    expect(codexModel("claude-opus-5-5", undefined)).toBeUndefined();
    expect(codexModel("claude-opus-5-5", "gpt-5.5")).toBe("gpt-5.5");
    expect(codexModel("gpt-5.5-mini", "gpt-5.5")).toBe("gpt-5.5-mini");
    expect(read).not.toContain("--model");
    expect(after(codexArgs({ ...opts(), cwd: "/s" }, "/s.json", "gpt-5.5"), "--model")).toBe("gpt-5.5");
  });
  it("puts Docent's instructions ahead of the prompt", () => {
    expect(codexPrompt("SYSTEM", "PROMPT", "none")).toMatch(/^<instructions>\nSYSTEM[\s\S]*Don't run commands[\s\S]*<\/instructions>\n\nPROMPT$/);
    expect(codexPrompt("S", "P", "read")).toContain("read-only commands");
  });
});

describe("Codex output", () => {
  const lines = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");
  it("takes the last agent message as the answer and sums usage", () => {
    const r = parseCodex(lines(
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { type: "reasoning", text: "thinking" } },
      { type: "item.completed", item: { type: "command_execution", command: "cat a.ts" } },
      { type: "item.completed", item: { type: "agent_message", text: '{"ok":true}' } },
      { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 3 } },
    ));
    expect(r).toMatchObject({ answer: { ok: true }, usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 40 } });
    expect(r.error).toBeUndefined();
  });
  it("reports a failed turn", () => {
    expect(parseCodex(lines({ type: "turn.failed", error: { message: "usage limit reached" } })).error).toBe("usage limit reached");
    expect(parseCodex("", "Error: not logged in\n").error).toContain("not logged in");
  });
  it("skips lines that aren't events", () => {
    expect(parseCodex(`warning: something\n${lines({ type: "item.completed", item: { type: "agent_message", text: '```json\n{"a":1}\n```' } })}`).answer).toEqual({ a: 1 });
  });
});

describe("strict schema", () => {
  const s = strictSchema(Schema) as { required: string[]; additionalProperties: boolean; properties: Record<string, any> };
  it("closes every object and requires every key", () => {
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["title", "steps", "why"]);
    const step = s.properties.steps.items;
    expect(step.additionalProperties).toBe(false);
    expect(step.required).toEqual(["n", "note"]);
    expect(step.properties.note.anyOf).toContainEqual({ type: "null" });
  });
  it("drops keywords strict mode refuses", () => {
    expect(s.properties.title).not.toHaveProperty("minLength");
  });
  it("accepts nulls for optional keys after the fact", () => {
    const answer = { title: "t", steps: [{ n: 1, note: null }], why: null };
    expect(parseAnswer(Schema, answer)).toEqual({ ok: true, data: { title: "t", steps: [{ n: 1 }], why: null } });
    const Opt = z.object({ a: z.string().optional(), b: z.array(z.object({ c: z.number().optional(), d: z.number().nullable() })) });
    expect(dropOptionalNulls(draft7(Opt), { a: null, b: [{ c: null, d: null }] })).toEqual({ b: [{ d: null }] });
  });
  it("names what's wrong", () => {
    const r = parseAnswer(Schema, { title: "", steps: "no", why: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toMatch(/title|steps/);
  });
});

describe("pulling JSON out of text", () => {
  it("handles bare JSON, fences and surrounding prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Sure! {"a":3} done')).toEqual({ a: 3 });
    expect(extractJson("no json")).toBeUndefined();
  });
});

/** A fake CLI: a shell script that answers wrongly unless the prompt carries the retry note. */
describe("the shared CLI base", () => {
  const dir = mkdtempSync(join(tmpdir(), "docent-cli-"));
  const bin = join(dir, "fake");
  writeFileSync(bin, `#!/bin/sh\nin=$(cat)\ncase "$in" in *"didn't match"*) echo '{"ok":true}';; *) echo '{"ok":"yes"}';; esac\n`);
  chmodSync(bin, 0o755);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  class Fake extends HeadlessCli {
    readonly id: ProviderId = "codex";
    readonly label = "Fake";
    calls: CliCall[] = [];
    protected plan() {
      return "nothing";
    }
    protected defaultModel() {
      return "fake-1";
    }
    protected probe(): CliStatus {
      return { installed: true, signedIn: true };
    }
    protected build(o: AskOptions<z.ZodType>, scratch: { dir: string }): CliCall {
      const call = { args: [], stdin: `${o.system}\n${o.prompt}`, cwd: scratch.dir };
      this.calls.push(call);
      return call;
    }
    protected parse(stdout: string): CliReply {
      return { answer: JSON.parse(stdout), usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    }
  }

  it("retries once with what was wrong, then succeeds", async () => {
    const fake = new Fake(bin);
    const r = await fake.ask({ system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }) });
    expect(r).toMatchObject({ data: { ok: true }, provider: "codex", model: "fake-1", usage: { inputTokens: 2 } });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.stdin).toContain("didn't match");
  });
  it("gives up after the retry with a clear error", async () => {
    const fake = new Fake(bin);
    await expect(fake.ask({ system: "s", prompt: "p", schema: z.object({ ok: z.number() }) })).rejects.toThrow(/didn't match the expected shape/);
    expect(fake.calls).toHaveLength(2);
  });
  it("redacts the prompt before the CLI sees it", async () => {
    const fake = new Fake(bin);
    const key = ["sk-ant-", "api03-", "abcdefghijklmnopqrstuvwxyz012345"].join("");
    await fake.ask({ system: "s", prompt: `key ${key}`, schema: z.object({ ok: z.boolean() }) }).catch(() => {});
    expect(fake.calls[0]!.stdin).not.toContain(key);
  });
  it("runs outside the repo when it doesn't read, and cleans up", async () => {
    const fake = new Fake(bin);
    await fake.ask({ system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }) });
    expect(fake.calls[0]!.cwd).toContain(join(homedir(), ".docent", "tmp"));
  });
});
