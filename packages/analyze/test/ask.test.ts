import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extract, type Facts } from "@docent/extract";
import type { LlmProvider } from "@docent/llm";
import { answerQuestion } from "../src/index.ts";

let root: string;
let facts: Facts;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "docent-ask-"));
  cpSync(join(import.meta.dirname, "../../extract/test/fixture"), root, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "Add upload pipeline");
  facts = extract(root);
});

/** A stand-in for Claude: the first call answers, the second (the second reader) gives verdicts. */
function fakeLlm(answer: unknown, verdicts: unknown): LlmProvider & { prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  return {
    id: "api",
    prompts,
    describe: () => "fake",
    ask: async (opts) => {
      prompts.push(opts.prompt);
      const data = call++ === 0 ? answer : verdicts;
      return { data: opts.schema.parse(data), provider: "api", model: "fake", durationMs: 0, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };
    },
  };
}

describe("Ask Docent", () => {
  const boxes = [{ id: "in:page#onSave", title: "Page.onSave" }, { id: "center", title: "upload()" }, { id: "out:api#post", title: "post" }];
  const links = [{ from: "in:page#onSave", to: "center" }, { from: "center", to: "out:api#post" }];

  it("shows Claude short box refs, maps the scene back to canvas ids, and drops boxes and links that aren't on screen", async () => {
    const llm = fakeLlm({
      paragraphs: [{ text: "upload calls helper", label: "confirmed", evidence: [{ file: "src/lib/upload.ts", start: 7, end: 12, mentions: ["helper(1)"] }], commit: "", searched: "" }],
      scene: [
        { boxes: ["b1", "b2"], links: [{ from: "b1", to: "b2" }], caption: "Saving starts the upload" },
        { boxes: ["b9"], links: [{ from: "b1", to: "b3" }], caption: "Invented" },
        { boxes: ["b3"], links: [{ from: "b3", to: "b2" }], caption: "Then it posts" },
      ],
    }, { verdicts: [{ id: 0, verdict: "upheld", reason: "line 9" }] });
    const out = await answerQuestion(llm, facts, root, { question: "What happens on save?", context: "ctx", boxes, links, history: [] });
    expect(llm.prompts[0]).toContain("b1: Page.onSave");
    expect(llm.prompts[0]).toContain("b1 → b2");
    expect(llm.prompts[0]).not.toContain("in:page#onSave");
    expect(out.scene).toEqual([
      { nodes: ["in:page#onSave", "center"], edges: [{ from: "in:page#onSave", to: "center" }], caption: "Saving starts the upload" },
      { nodes: ["out:api#post"], edges: [{ from: "center", to: "out:api#post" }], caption: "Then it posts" },
    ]);
    expect(out.paragraphs[0]!.label).toBe("confirmed");
  });

  it("checks every paragraph like any other claim: a bad citation is demoted before the second reader sees it", async () => {
    const llm = fakeLlm({
      paragraphs: [
        { text: "upload retries", label: "confirmed", evidence: [{ file: "src/lib/upload.ts", start: 1, end: 2, mentions: ["retry("] }], commit: "", searched: "" },
        { text: "upload calls helper", label: "confirmed", evidence: [{ file: "src/lib/upload.ts", start: 7, end: 12, mentions: ["helper(1)"] }], commit: "", searched: "" },
      ],
      scene: [],
    }, { verdicts: [{ id: 1, verdict: "refuted", reason: "it calls client.post, not helper" }] });
    const out = await answerQuestion(llm, facts, root, { question: "q", context: "ctx", boxes, links, history: [] });
    expect(out.paragraphs.map((p) => p.label)).toEqual(["inferred", "unknown"]);
    expect(llm.prompts[1]).not.toContain("[0]");
  });
});
