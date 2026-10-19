import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extract, type Facts } from "../src/index.ts";

const load = (fixture: string): Facts => {
  const root = mkdtempSync(join(tmpdir(), `docent-${fixture}-`));
  cpSync(join(import.meta.dirname, fixture), root, { recursive: true });
  return extract(root);
};

describe("a Python (Flask) project", () => {
  let facts: Facts;
  beforeAll(() => {
    facts = load("fixture-python");
  });

  it("reads the stack from pyproject.toml", () => {
    expect(facts.stack).toEqual(expect.arrayContaining(["Flask", "SQLAlchemy", "pytest"]));
  });

  it("classifies tests and manifests", () => {
    const kind = (p: string) => facts.files.find((f) => f.path === p)?.kind;
    expect(kind("tests/test_notes.py")).toBe("test");
    expect(kind("pyproject.toml")).toBe("config");
    expect(kind("app/routes.py")).toBe("source");
  });

  it("finds routes with their handler and line, the __main__ block and the console script", () => {
    const routes = facts.entries.filter((e) => e.kind === "route").map((e) => [e.file, e.detail]);
    expect(routes).toEqual([
      ["app/routes.py", "GET,POST /notes → notes (line 9)"],
      ["app/routes.py", "DELETE /notes/<int:note_id> → delete_note (line 17)"],
    ]);
    expect(facts.entries).toContainEqual({ kind: "main", file: "app/cli.py", detail: 'if __name__ == "__main__" (line 10)', confidence: "confirmed" });
    expect(facts.entries).toContainEqual({ kind: "bin", file: "app/cli.py", detail: "command notes → app.cli:main", confidence: "confirmed" });
  });

  it("collects env vars and markers", () => {
    expect(facts.env).toEqual([
      { name: "PORT", file: "app/cli.py", line: 7 },
      { name: "NOTES_MAX_LENGTH", file: "app/services/notes.py", line: 3 },
    ]);
    expect(facts.markers).toContainEqual(expect.objectContaining({ kind: "TODO", file: "app/services/notes.py", line: 20 }));
  });
});

describe("a Go (gin + net/http) project", () => {
  let facts: Facts;
  beforeAll(() => {
    facts = load("fixture-go");
  });

  it("reads the stack from go.mod", () => {
    expect(facts.stack).toEqual(expect.arrayContaining(["Gin", "testify"]));
  });

  it("classifies tests and manifests", () => {
    const kind = (p: string) => facts.files.find((f) => f.path === p)?.kind;
    expect(kind("internal/store/store_test.go")).toBe("test");
    expect(kind("go.mod")).toBe("config");
  });

  it("finds func main and every route with its handler and line", () => {
    expect(facts.entries).toContainEqual({ kind: "main", file: "cmd/server/main.go", detail: "func main (line 13)", confidence: "confirmed" });
    expect(facts.entries.filter((e) => e.kind === "route").map((e) => e.detail)).toEqual([
      "GET /todos → listTodos (line 16)",
      "POST /todos → addTodo (line 17)",
      "ANY /healthz → health (line 18)",
    ]);
  });

  it("collects env vars and markers", () => {
    expect(facts.env).toEqual([{ name: "PORT", file: "cmd/server/main.go", line: 19 }]);
    expect(facts.markers).toContainEqual(expect.objectContaining({ kind: "TODO", file: "internal/store/store.go", line: 31 }));
  });
});
