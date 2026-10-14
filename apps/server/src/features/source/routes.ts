import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { SourceSlice } from "@docent/contracts";
import type { Facts } from "@docent/extract";

/** Read-only file access, limited to files the facts list. No path from the client reaches the disk otherwise. */
export function sourceRoutes(root: string, facts: () => Facts): Hono {
  return new Hono().get("/source", (c) => {
    const path = c.req.query("path") ?? "";
    const file = facts().files.find((f) => f.path === path);
    if (!file) return c.json({ error: "Not a file in this repo" }, 404);
    const lines = readFileSync(join(root, file.path), "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const from = Math.max(1, Number(c.req.query("from") ?? 1) || 1);
    const to = Math.min(lines.length, Number(c.req.query("to") ?? lines.length) || lines.length);
    return c.json<SourceSlice>({ path, lang: file.lang, start: from, total: lines.length, lines: lines.slice(from - 1, to) });
  });
}
