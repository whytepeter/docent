import { Hono } from "hono";
import type { Status } from "@docent/contracts";
import type { RepoService } from "./service.ts";

export function repoRoutes(repo: RepoService): Hono {
  return new Hono()
    .get("/status", (c) => c.json<Status>({
      factsHead: repo.facts.repo.head,
      head: repo.head(),
      stale: repo.isStale(),
      extracting: repo.extracting,
      version: repo.version,
    }))
    .post("/reextract", async (c) => {
      await repo.reextract();
      return c.json<Status>({ factsHead: repo.facts.repo.head, head: repo.head(), stale: false, extracting: false, version: repo.version });
    });
}
