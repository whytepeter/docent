import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntryFact, FileFact } from "./types.ts";

/**
 * Python and Go projects: what they are built with (from their manifests) and where they start (from the
 * code itself). Routes and `main` functions are read from the line that declares them, so they are confirmed.
 */

const PY_STACK: Record<string, string> = {
  flask: "Flask", fastapi: "FastAPI", django: "Django", starlette: "Starlette", sqlalchemy: "SQLAlchemy",
  pydantic: "Pydantic", celery: "Celery", pytest: "pytest", click: "Click", typer: "Typer", aiohttp: "aiohttp",
  "flask-sqlalchemy": "SQLAlchemy", djangorestframework: "Django REST framework", alembic: "Alembic", uvicorn: "Uvicorn",
};

const GO_STACK: Record<string, string> = {
  "github.com/gin-gonic/gin": "Gin", "github.com/labstack/echo": "Echo", "github.com/go-chi/chi": "chi",
  "github.com/gofiber/fiber": "Fiber", "github.com/gorilla/mux": "gorilla/mux", "github.com/spf13/cobra": "Cobra",
  "gorm.io/gorm": "GORM", "google.golang.org/grpc": "gRPC", "github.com/stretchr/testify": "testify",
};

const read = (root: string, path: string) => {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return "";
  }
};

/** `Flask>=2.0`, `fastapi[all]==0.1` → `flask`, `fastapi`. */
const reqName = (spec: string) => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1]?.toLowerCase().replace(/_/g, "-") ?? null;

/** Dependencies named in pyproject.toml, requirements*.txt, setup.py/cfg and Pipfile. */
export function pythonDeps(root: string, files: FileFact[]): Set<string> {
  const deps = new Set<string>();
  const add = (spec: string) => {
    const name = reqName(spec);
    if (name) deps.add(name);
  };
  const pyproject = read(root, "pyproject.toml");
  if (pyproject) {
    // PEP 621 `dependencies = [...]`, and every array under optional-dependencies or dependency-groups.
    const arrays = (text: string) => { for (const m of text.matchAll(/=\s*\[([\s\S]*?)\]/g)) for (const s of m[1]!.matchAll(/["']([^"']+)["']/g)) add(s[1]!); };
    for (const section of pyproject.split(/^\[/m)) {
      if (/^project\]/.test(section)) for (const m of section.matchAll(/^dependencies\s*=\s*\[[\s\S]*?\]/gm)) arrays(m[0]);
      if (/^(project\.optional-dependencies|dependency-groups)\]/.test(section)) arrays(section);
    }
    // Poetry: one dependency per line under [tool.poetry.*dependencies].
    for (const section of pyproject.split(/^\[/m)) {
      if (!/^tool\.poetry\.(group\.[\w-]+\.)?(dev-)?dependencies\]/.test(section)) continue;
      for (const line of section.split("\n").slice(1)) if (/^\s*[A-Za-z]/.test(line) && line.includes("=")) add(line);
    }
  }
  for (const f of files.filter((f) => /(^|\/)requirements[^/]*\.txt$/.test(f.path))) {
    for (const line of read(root, f.path).split("\n")) if (!/^\s*(#|-)/.test(line)) add(line);
  }
  const setup = read(root, "setup.py") + read(root, "setup.cfg");
  for (const m of setup.matchAll(/install_requires\s*=\s*\[([\s\S]*?)\]/g)) for (const s of m[1]!.matchAll(/["']([^"']+)["']/g)) add(s[1]!);
  const cfgReqs = /install_requires\s*=\s*\n((?:[ \t]+\S.*\n?)+)/.exec(setup);
  if (cfgReqs) for (const line of cfgReqs[1]!.split("\n")) add(line);
  for (const section of read(root, "Pipfile").split(/^\[/m)) {
    if (!/^(dev-)?packages\]/.test(section)) continue;
    for (const line of section.split("\n").slice(1)) if (line.includes("=")) add(line.split("=")[0]!);
  }
  return deps;
}

/** go.mod: the module path (how the repo imports its own packages) and what it requires. */
export function goModule(root: string): { module: string | null; requires: string[] } {
  const mod = read(root, "go.mod");
  if (!mod) return { module: null, requires: [] };
  const requires: string[] = [];
  for (const m of mod.matchAll(/^require\s+\(([\s\S]*?)\)/gm)) for (const line of m[1]!.split("\n")) {
    const dep = /^\s*([^\s/]+\.[^\s]+)\s+v/.exec(line)?.[1];
    if (dep) requires.push(dep);
  }
  for (const m of mod.matchAll(/^require\s+([^\s(]+)\s+v/gm)) requires.push(m[1]!);
  return { module: /^module\s+(\S+)/m.exec(mod)?.[1] ?? null, requires };
}

const HTTP_VERBS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Get|Post|Put|Patch|Delete|Head|Options|Handle|HandleFunc|Group|Route|Mount";

export function pythonGoStackAndEntries(root: string, files: FileFact[]): { stack: string[]; entries: EntryFact[] } {
  const stack = new Set<string>();
  const entries: EntryFact[] = [];
  const hasPy = files.some((f) => f.lang === "python");
  const hasGo = files.some((f) => f.lang === "go");

  if (hasPy) {
    for (const dep of pythonDeps(root, files)) if (PY_STACK[dep]) stack.add(PY_STACK[dep]!);
    const pyproject = read(root, "pyproject.toml");
    const scripts = /^\[(?:project\.scripts|tool\.poetry\.scripts)\]\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(pyproject)?.[1] ?? "";
    for (const line of scripts.split("\n")) {
      const m = /^\s*([\w.-]+)\s*=\s*["']([\w.]+):([\w.]+)["']/.exec(line);
      if (!m) continue;
      const mod = m[2]!.replace(/\./g, "/");
      const file = [`${mod}.py`, `src/${mod}.py`, `${mod}/__init__.py`, `src/${mod}/__init__.py`].find((p) => files.some((f) => f.path === p));
      entries.push({ kind: "bin", file: file ?? "pyproject.toml", detail: `command ${m[1]} → ${m[2]}:${m[3]}`, confidence: file ? "confirmed" : "inferred" });
    }
  }
  if (hasGo) {
    const { requires } = goModule(root);
    for (const dep of requires) {
      const known = Object.keys(GO_STACK).find((k) => dep === k || dep.startsWith(`${k}/`));
      if (known) stack.add(GO_STACK[known]!);
    }
  }

  for (const file of files.filter((f) => (f.lang === "python" || f.lang === "go") && f.kind === "source")) {
    const lines = read(root, file.path).split("\n");
    if (file.lang === "python") pythonEntries(file.path, lines, entries, stack);
    else goEntries(file.path, lines, entries);
  }
  return { stack: [...stack], entries };
}

function pythonEntries(path: string, lines: string[], entries: EntryFact[], stack: Set<string>): void {
  const name = path.split("/").pop()!;
  if (name === "__main__.py") entries.push({ kind: "main", file: path, detail: "runs with python -m", confidence: "confirmed" });
  if (name === "manage.py") entries.push({ kind: "main", file: path, detail: "Django management commands", confidence: "confirmed" });
  if (/^(wsgi|asgi)\.py$/.test(name)) entries.push({ kind: "server", file: path, detail: `${name.slice(0, 4).toUpperCase()} application`, confidence: "confirmed" });
  lines.forEach((line, i) => {
    // The module that builds the web app: what `flask run` (FLASK_APP) or `uvicorn module:app` loads.
    const app = /^(\w+)\s*(?::\s*\w+\s*)?=\s*(create_app|make_app|Flask|FastAPI|Starlette|Quart|Sanic)\(/.exec(line);
    if (app) entries.push({ kind: "server", file: path, detail: `${app[1]} = ${app[2]}(…) (line ${i + 1})`, confidence: "confirmed" });
    if (/^if\s+__name__\s*==\s*["']__main__["']\s*:/.test(line)) entries.push({ kind: "main", file: path, detail: `if __name__ == "__main__" (line ${i + 1})`, confidence: "confirmed" });
    // Flask `@app.route("/x", methods=[...])`, `@bp.get("/x")`; FastAPI `@router.post("/x")`.
    const deco = /^\s*@(\w+(?:\.\w+)*)\.(route|get|post|put|patch|delete|websocket|api_route)\(\s*(?:path\s*=\s*)?["']([^"']*)["']([^)]*)/.exec(line);
    if (deco) {
      const handler = lines.slice(i + 1, i + 8).map((l) => /^\s*(?:async\s+)?def\s+(\w+)/.exec(l)?.[1]).find(Boolean);
      const methods = deco[2] === "route" ? (/methods\s*=\s*\[([^\]]*)\]/.exec(deco[4]!)?.[1]?.replace(/["'\s]/g, "") || "GET") : deco[2]!.toUpperCase();
      entries.push({ kind: "route", file: path, detail: `${methods} ${deco[3]} → ${handler ?? "?"} (line ${i + 1})`, confidence: "confirmed" });
      return;
    }
    // Django `path("x/", views.thing)` and `re_path(...)` in a urls.py.
    const dj = name === "urls.py" && /^\s*(?:re_)?path\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)/.exec(line);
    if (dj) {
      stack.add("Django");
      entries.push({ kind: "route", file: path, detail: `/${dj[1]} → ${dj[2]} (line ${i + 1})`, confidence: "confirmed" });
    }
  });
}

function goEntries(path: string, lines: string[], entries: EntryFact[]): void {
  const isMain = lines.some((l) => /^package\s+main\b/.test(l));
  lines.forEach((line, i) => {
    if (isMain && /^func\s+main\s*\(\s*\)/.test(line)) entries.push({ kind: "main", file: path, detail: `func main (line ${i + 1})`, confidence: "confirmed" });
    // net/http `http.HandleFunc("/x", h)`, `mux.Handle(...)`; gin/echo/chi/fiber `r.GET("/x", h)`, `r.Get(...)`.
    const route = new RegExp(`\\b(\\w+)\\.(${HTTP_VERBS})\\(\\s*"([^"]*)"\\s*(?:,\\s*([\\w.]+))?`).exec(line);
    if (route && /^\//.test(route[3]!.replace(/^(GET|POST|PUT|PATCH|DELETE) /, ""))) {
      const verb = route[2]!;
      if (verb === "Group" || verb === "Route" || verb === "Mount") return;
      const method = /^Handle/.test(verb) ? (/^([A-Z]+) /.exec(route[3]!)?.[1] ?? "ANY") : verb.toUpperCase();
      const pathPart = route[3]!.replace(/^[A-Z]+ /, "");
      entries.push({ kind: "route", file: path, detail: `${method} ${pathPart} → ${route[4] ?? "inline handler"} (line ${i + 1})`, confidence: "confirmed" });
    }
  });
}
