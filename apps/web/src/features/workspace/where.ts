import type { RepoSource } from "@docent/contracts";
import type { IconName } from "../../shared/ui/index.ts";

export const home = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

/** How a project is named under its title: its folder, the GitHub repo it was cloned from, or the zip it came in. */
export function where(r: { root: string; source?: RepoSource }): { icon: IconName; text: string; title: string } {
  const s = r.source;
  if (s?.kind === "github") return { icon: "git", text: `github.com/${s.repo}${s.branch ? ` · ${s.branch}` : ""}`, title: `Cloned from ${s.url} into ${home(r.root)}` };
  if (s?.kind === "zip") return { icon: "zip", text: `${s.file} · no git history`, title: `Unpacked from ${s.file} into ${home(r.root)}` };
  return { icon: "project", text: home(r.root), title: home(r.root) };
}
