import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extract, type Facts } from "../src/index.ts";

const load = async (fixture: string): Promise<Facts> => {
  const root = mkdtempSync(join(tmpdir(), `docent-${fixture}-`));
  cpSync(join(import.meta.dirname, fixture), root, { recursive: true });
  return extract(root);
};

describe("a Python (Flask) project", () => {
  let facts: Facts;
  beforeAll(async () => {
    facts = await load("fixture-python");
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
  beforeAll(async () => {
    facts = await load("fixture-go");
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

describe("the Python call graph", () => {
  let facts: Facts;
  beforeAll(async () => {
    facts = await load("fixture-python");
  });
  const sym = (id: string) => facts.symbols.find((s) => s.id === id);
  const edge = (from: string, to: string) => facts.edges.find((e) => e.from === from && e.to === to);

  it("reads functions, classes, methods and constants with their lines; a route's range starts at its decorator", () => {
    expect(sym("app/routes.py#notes")).toMatchObject({ kind: "function", range: { start: 9, end: 14 }, exported: true });
    expect(sym("app/services/notes.py#NoteService.create")).toMatchObject({ kind: "method", range: { start: 10, end: 14 }, parent: "app/services/notes.py#NoteService" });
    expect(sym("app/services/notes.py#_clean")).toMatchObject({ exported: false });
    expect(sym("app/services/notes.py#MAX_LENGTH")?.kind).toBe("const");
  });

  it("resolves absolute, relative and package imports to files, and names packages", () => {
    const to = (from: string) => facts.imports.filter((i) => i.from === from).map((i) => i.to ?? `pkg:${i.external}`);
    expect(to("app/__init__.py")).toEqual(["pkg:flask", "app/routes.py"]);
    expect(to("app/cli.py")).toEqual(["pkg:os", "app/__init__.py"]);
    expect(to("app/routes.py")).toEqual(["pkg:flask", "app/services/notes.py"]);
  });

  it("confirms calls fixed by the code, and labels calls through a variable's class as inferred", () => {
    expect(edge("app/cli.py#main", "app/__init__.py#create_app")).toMatchObject({ kind: "calls", line: 7, confidence: "confirmed" });
    expect(edge("app/services/notes.py#NoteService.create", "app/services/notes.py#_clean")).toMatchObject({ line: 11, confidence: "confirmed" });
    expect(edge("app/routes.py#<module>", "app/services/notes.py#NoteService")).toMatchObject({ kind: "constructs", line: 6, confidence: "confirmed" });
    expect(edge("app/routes.py#notes", "app/services/notes.py#NoteService.create")).toMatchObject({ line: 12, confidence: "inferred", via: "class from the assignment" });
  });

  it("maps pytest functions and test-class methods to the code they exercise", () => {
    expect(facts.tests.map((t) => t.id)).toEqual(["tests/test_notes.py#test:test_create_trims_text", "tests/test_notes.py#test:TestRemove > test_remove_missing_is_quiet"]);
    expect(edge("tests/test_notes.py#test:TestRemove > test_remove_missing_is_quiet", "app/services/notes.py#NoteService.remove")).toMatchObject({ line: 11, via: "class from the call" });
  });

  it("counts every imported module as used", () => {
    expect(facts.unreferenced).toEqual([]);
    expect(facts.warnings.filter((w) => !/No git history/.test(w))).toEqual([]);
  });
});

describe("the Go call graph", () => {
  let facts: Facts;
  beforeAll(async () => {
    facts = await load("fixture-go");
  });
  const sym = (id: string) => facts.symbols.find((s) => s.id === id);
  const edge = (from: string, to: string) => facts.edges.find((e) => e.from === from && e.to === to);

  it("reads funcs, methods on their receiver type, and structs, with exported by capital letter", () => {
    expect(sym("internal/store/store.go#Store.Add")).toMatchObject({ kind: "method", range: { start: 20, end: 24 }, exported: true, parent: "internal/store/store.go#Store" });
    expect(sym("internal/store/store.go#Store")?.kind).toBe("class");
    expect(sym("internal/store/store.go#normalize")?.exported).toBe(false);
  });

  it("resolves the repo's own packages through go.mod, and names outside modules", () => {
    const main = facts.imports.filter((i) => i.from === "cmd/server/main.go");
    expect(main.find((i) => i.specifier === "example.com/todo/internal/store")).toMatchObject({ to: "internal/store/store.go", confidence: "confirmed" });
    expect(main.find((i) => i.specifier === "github.com/gin-gonic/gin")?.external).toBe("github.com/gin-gonic/gin");
  });

  it("confirms package calls and method calls whose receiver type is written in the code", () => {
    expect(edge("cmd/server/main.go#main", "internal/store/store.go#New")).toMatchObject({ line: 14, confidence: "confirmed" });
    // `s *store.Store` is a parameter, so `s.All()` is that method.
    expect(edge("cmd/server/main.go#listTodos", "internal/store/store.go#Store.All")).toMatchObject({ line: 27, confidence: "confirmed" });
    expect(edge("internal/store/store.go#Store.Add", "internal/store/store.go#normalize")).toMatchObject({ line: 21, confidence: "confirmed" });
    expect(edge("internal/store/store.go#New", "internal/store/store.go#Store")).toMatchObject({ kind: "constructs", line: 17 });
  });

  it("maps a test and its t.Run subtest to the code they exercise, through New's declared result", () => {
    expect(facts.tests.map((t) => t.id)).toEqual(["internal/store/store_test.go#test:TestAdd", "internal/store/store_test.go#test:TestAdd > trims the title"]);
    expect(edge("internal/store/store_test.go#test:TestAdd > trims the title", "internal/store/store.go#Store.Add")).toMatchObject({ line: 8, confidence: "confirmed" });
  });

  it("counts a package's files as used when the package is imported or holds main", () => {
    expect(facts.unreferenced).toEqual([]);
    expect(facts.warnings.filter((w) => !/No git history/.test(w))).toEqual([]);
  });
});
