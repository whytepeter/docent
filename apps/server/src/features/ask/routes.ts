import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { answerQuestion } from "@docent/analyze";
import type { AskEvent, AskRequest, AskedBefore } from "@docent/contracts";
import { pickProvider } from "@docent/llm";
import type { GraphIndex } from "../graph/index.ts";
import type { RepoService } from "../repo/index.ts";
import { askedBefore, cachedAnswer, saveAnswer } from "./cache.ts";
import { viewContext } from "./context.ts";

/**
 * One question at a time, answered from the view it was asked in. Progress streams as server-sent events.
 * On a board, an answer is kept on disk: the same question about the same card, for the same board and
 * code, is answered at once, and the board's conversation comes back after a reload.
 */
export function askRoutes(repo: RepoService, index: () => GraphIndex): Hono {
  return new Hono()
    .get("/ask/history", (c) => {
      const board = c.req.query("board");
      return c.json<AskedBefore[]>(board ? askedBefore(repo.root, repo.facts, board) : []);
    })
    .post("/ask", async (c) => {
    const body = (await c.req.json()) as AskRequest;
    if (!body.question?.trim()) return c.json({ error: "Ask a question first" }, 400);
    const abort = new AbortController();
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => abort.abort());
      const send = (e: AskEvent) => stream.writeSSE({ data: JSON.stringify(e) });
      const question = body.question.trim();
      const r = body.route;
      try {
        if (r.view === "board") {
          const hit = cachedAnswer(repo.root, repo.facts, r.id, question, r.step, r.card);
          if (hit) return void (await send({ type: "answer", answer: hit.answer, cachedAt: hit.at }));
        }
        await send({ type: "stage", stage: "reading" });
        const context = viewContext(repo.root, index(), body.route);
        const answer = await answerQuestion(pickProvider(), repo.facts, repo.root, {
          question,
          context,
          boxes: body.boxes.slice(0, 80),
          links: body.links.slice(0, 200),
          history: body.history ?? [],
        }, { signal: abort.signal, onStage: (stage) => void send({ type: "stage", stage }), onDraft: (answer) => void send({ type: "draft", answer }) });
        if (r.view === "board") saveAnswer(repo.root, repo.facts, r.id, question, answer, r.step, r.card);
        await send({ type: "answer", answer });
      } catch (e) {
        if (!abort.signal.aborted) await send({ type: "error", error: (e as Error).message });
      }
    });
  });
}
