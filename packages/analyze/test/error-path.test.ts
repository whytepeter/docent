import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extract, type Facts } from "@docent/extract";
import { citeBoard, cleanBoard, errorPathSource, findErrorPath, followErrors, type Flow } from "../src/index.ts";

/** A small Express app: the service throws a 401, catchAsync passes it to next, errorHandler sends it. */
const FILES: Record<string, string> = {
  "package.json": `{ "name": "app", "dependencies": { "express": "4" } }`,
  "src/app.js": [
    "const express = require('express');",
    "const morgan = require('morgan');",
    "const { errorConverter, errorHandler } = require('./middlewares/error');",
    "const routes = require('./routes');",
    "const app = express();",
    "app.use(morgan.errorHandler);",
    "app.use('/v1', routes);",
    "app.use(errorConverter);",
    "app.use(errorHandler);",
    "module.exports = app;",
  ].join("\n"),
  "src/routes.js": [
    "const router = require('express').Router();",
    "const auth = require('./controller');",
    "router.post('/login', auth.login);",
    "module.exports = router;",
  ].join("\n"),
  "src/controller.js": [
    "const catchAsync = require('./catchAsync');",
    "const service = require('./service');",
    "const login = catchAsync(async (req, res) => {",
    "  const user = await service.login(req.body.email, req.body.password);",
    "  res.send({ user });",
    "});",
    "module.exports = { login };",
  ].join("\n"),
  "src/service.js": [
    "const ApiError = require('./ApiError');",
    "const login = async (email, password) => {",
    "  const user = await find(email);",
    "  if (!user || user.password !== password) {",
    "    throw new ApiError(401, 'Incorrect email or password');",
    "  }",
    "  return user;",
    "};",
    "const find = async (email) => ({ email, password: 'x' });",
    "module.exports = { login };",
  ].join("\n"),
  "src/ApiError.js": "class ApiError extends Error {\n  constructor(statusCode, message) {\n    super(message);\n    this.statusCode = statusCode;\n  }\n}\nmodule.exports = ApiError;",
  "src/catchAsync.js": "const catchAsync = (fn) => (req, res, next) => {\n  Promise.resolve(fn(req, res, next)).catch((err) => next(err));\n};\nmodule.exports = catchAsync;",
  "src/middlewares/error.js": [
    "const ApiError = require('../ApiError');",
    "const errorConverter = (err, req, res, next) => {",
    "  const error = err instanceof ApiError ? err : new ApiError(500, err.message);",
    "  next(error);",
    "};",
    "// eslint-disable-next-line no-unused-vars",
    "const errorHandler = (err, req, res, next) => {",
    "  const { statusCode, message } = err;",
    "  res.status(statusCode).send({ code: statusCode, message });",
    "};",
    "module.exports = { errorConverter, errorHandler };",
  ].join("\n"),
};

let facts: Facts;
let root: string;
const flow: Flow = { id: "login", title: "Log in", summary: "s", entry: "src/routes.js", files: ["src/routes.js", "src/controller.js", "src/service.js"] };
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "docent-errors-"));
  for (const [p, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "App");
  facts = extract(root);
});

type Spec = Parameters<typeof cleanBoard>[0];
const claim = (text: string, evidence: { file: string; start: number; end: number; mentions: string[] }[] = []) => ({ text, label: "confirmed" as const, evidence, commit: "", searched: "" });
const beat = { text: "words", tone: "calm" as const, lines: [], values: [], focus: [], claim: null, analogy: false };

function spec(): Spec {
  return {
    title: "t", intro: "i", pitch: "p",
    cards: [
      { id: "route", title: "Route", file: "src/routes.js", start: 1, end: 4, hot: [], role: "r", why: claim("w"), say: claim("s") },
      { id: "controller", title: "Controller", file: "src/controller.js", start: 1, end: 7, hot: [], role: "r", why: claim("w"), say: claim("s") },
      { id: "service", title: "Service", file: "src/service.js", start: 1, end: 10, hot: [], role: "r", why: claim("w"), say: claim("s") },
    ],
    edges: [{ from: "route", to: "controller", label: "POST", type: "" }, { from: "controller", to: "service", label: "email", type: "" }],
    steps: [
      { part: "fail", card: "service", route: [], touches: [], state: [], hops: [{ edge: "route>controller", back: false, stat: "ok", tone: "ok" }, { edge: "controller>service", back: false, stat: "401 incorrect", tone: "bad" }],
        beats: [{ ...beat, kind: "point", lines: [5], claim: claim("It throws a 401.", [{ file: "src/service.js", start: 4, end: 5, mentions: ["ApiError"] }]) }] },
    ],
    example: null,
  };
}

describe("error path", () => {
  it("finds the wrapper, where the handlers are registered and the line that sends the reply", () => {
    const path = findErrorPath(facts, root)!;
    expect(path.bridges.map((b) => b.name)).toEqual(["catchAsync"]);
    // morgan.errorHandler is someone else's handler.
    expect(path.registered.map((r) => `${r.file}:${r.start} ${r.name}`)).toEqual(["src/app.js:8 errorConverter", "src/app.js:9 errorHandler"]);
    expect(path.handlers.map((h) => h.name)).toEqual(["errorConverter", "errorHandler"]);
    expect(path.sender).toMatchObject({ line: 9, text: "res.status(statusCode).send(", site: { file: "src/middlewares/error.js", name: "errorHandler" } });
  });

  it("gives the writer that code when the flow throws and the handler isn't in its files", () => {
    const text = errorPathSource(facts, root, flow);
    expect(text).toContain("=== src/catchAsync.js lines 1–3 (catchAsync)");
    expect(text).toContain("    9  app.use(errorHandler);");
    expect(text).toContain("The reply is sent at src/middlewares/error.js:9.");
    expect(errorPathSource(facts, root, { ...flow, files: [...flow.files, "src/middlewares/error.js"] })).toBe("");
  });

  it("follows a throw to the handler: a card, the hop to it, and a step with evidence for each hand-off", () => {
    const b = citeBoard(followErrors(cleanBoard(spec(), facts, root, "login", "m"), facts, root, flow), facts, root);
    const handler = b.cards.at(-1)!;
    expect(handler).toMatchObject({ id: "error-handler", file: "src/middlewares/error.js", start: 7, hot: [9] });
    expect(b.edges.at(-1)).toMatchObject({ from: "service", to: "error-handler" });
    const [atThrow, atHandler] = b.steps;
    expect(atThrow!.hops.at(-1)).toEqual({ edge: "service>error-handler", back: false, stat: "401 sent", tone: "bad" });
    expect(atHandler).toMatchObject({ part: "fail", card: "error-handler" });
    const point = atHandler!.beats.find((x) => x.kind === "point")!;
    expect(point.lines).toEqual([9]);
    expect(point.values).toEqual([{ line: 9, text: "statusCode = 401", other: "" }]);
    expect(point.claim!.label).toBe("confirmed");
    expect(point.claim!.evidence.map((e) => `${e.file}:${e.start}-${e.end} ${e.check.ok}`)).toEqual([
      "src/catchAsync.js:1-3 true", "src/app.js:8-8 true", "src/app.js:9-9 true", "src/middlewares/error.js:9-9 true",
    ]);
    expect(handler.why.evidence.every((e) => e.check.ok) && handler.say.evidence.every((e) => e.check.ok)).toBe(true);
  });

  it("leaves a board alone when the writer already followed the error, or nothing throws", () => {
    const followed = cleanBoard(spec(), facts, root, "login", "m");
    const once = followErrors(followed, facts, root, flow);
    expect(followErrors(once, facts, root, flow)).toEqual(once);
    const calm = spec();
    calm.steps[0]!.beats = [{ ...beat, kind: "point", lines: [7], claim: claim("Returns the user.", [{ file: "src/service.js", start: 7, end: 7, mentions: ["user"] }]) }];
    const b = cleanBoard(calm, facts, root, "login", "m");
    expect(followErrors(b, facts, root, flow)).toBe(b);
  });
});
