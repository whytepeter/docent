import type { Area } from "@docent/contracts";

/**
 * Folders whose children are the real units (`features/document-upload`, `shared/services`).
 * Until M3 discovers features, areas stand in for them: they come from the folder layout alone.
 */
const CONTAINERS = new Set([
  "features", "modules", "components", "shared", "app", "pages", "lib", "services", "packages", "apps",
  "domains", "routes", "views", "stores", "hooks", "utils", "server", "api", "composables", "cmd", "internal", "pkg",
]);

const humanize = (segment: string) => {
  const words = segment.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function areaOf(path: string): Pick<Area, "id" | "label" | "group" | "path"> {
  const dirs = path.split("/").slice(0, -1);
  const srcAt = dirs.indexOf("src");
  const prefix = srcAt >= 0 && srcAt <= 2 ? dirs.slice(0, srcAt + 1) : [];
  const rest = dirs.slice(prefix.length);
  if (rest.length === 0) {
    // A package's own src root (packages/llm/src) is that package, merged with its other folders (packages/llm/test).
    if (prefix.length > 1) {
      const pkg = prefix.slice(0, -1);
      const id = pkg.join("/");
      return { id, label: humanize(pkg.at(-1)!), group: pkg.length >= 2 && CONTAINERS.has(pkg[0]!) ? pkg[0]! : null, path: id };
    }
    const id = prefix.join("/") || ".";
    return { id, label: "Top level", group: null, path: id };
  }
  const unit = CONTAINERS.has(rest[0]!) && rest.length >= 2 ? rest.slice(0, 2) : rest.slice(0, 1);
  const id = [...prefix, ...unit].join("/");
  return { id, label: humanize(unit[unit.length - 1]!), group: unit.length === 2 ? unit[0]! : null, path: id };
}
