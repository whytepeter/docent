import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { CloneJob, GithubStart, RepoSource } from "@docent/contracts";

/** Clones Docent made itself. They are Docent's own folders, but their content is still only read, never run. */
export const CHECKOUTS = join(homedir(), ".docent", "checkouts");

export interface GithubRef {
  owner: string;
  repo: string;
  branch?: string;
  /** What git clones from: SSH when the user pasted an SSH address, HTTPS otherwise. */
  url: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const okName = (n: string) => NAME.test(n) && !/^[-.]/.test(n);

/**
 * Reads what the user pasted: https://github.com/owner/repo (with .git, a trailing slash, or /tree/<branch>),
 * github.com/owner/repo, git@github.com:owner/repo.git, ssh://git@github.com/owner/repo, or just owner/repo.
 * A /tree/ or /blob/ URL keeps its first segment as the branch; the rest of the path is ignored.
 */
export function parseGithub(input: string): GithubRef | null {
  const s = input.trim();
  let rest: string | undefined;
  let ssh = false;
  let m: RegExpExecArray | null;
  if ((m = /^git@github\.com:(.+)$/i.exec(s)) || (m = /^ssh:\/\/git@github\.com\/(.+)$/i.exec(s))) {
    ssh = true;
    rest = m[1];
  } else if ((m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(s))) rest = m[1];
  else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) rest = s;
  if (!rest) return null;
  const parts = rest.replace(/[?#].*$/, "").split("/").filter(Boolean);
  const owner = parts[0] ?? "";
  const repo = (parts[1] ?? "").replace(/\.git$/i, "");
  if (!okName(owner) || !okName(repo)) return null;
  let branch: string | undefined;
  if ((parts[2] === "tree" || parts[2] === "blob") && parts[3]) {
    branch = decodeURIComponent(parts[3]);
    if (!okName(branch)) return null;
  }
  return { owner, repo, branch, url: ssh ? `git@github.com:${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git` };
}

/** One folder per repo (and per branch, when a branch was asked for). GitHub names are case-insensitive. */
export function checkoutDir(ref: GithubRef): string {
  return join(CHECKOUTS, `${ref.owner}-${ref.repo}${ref.branch ? `@${ref.branch}` : ""}`.toLowerCase());
}

export const sourceOf = (ref: GithubRef): RepoSource => ({
  kind: "github",
  repo: `${ref.owner}/${ref.repo}`,
  url: `https://github.com/${ref.owner}/${ref.repo}${ref.branch ? `/tree/${ref.branch}` : ""}`,
  ...(ref.branch ? { branch: ref.branch } : {}),
});

/** A checkout under ~/.docent/checkouts, read back from its origin remote. Null for any other folder. */
export function checkoutSource(root: string): RepoSource | null {
  if (!root.startsWith(CHECKOUTS + sep)) return null;
  try {
    const origin = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const ref = parseGithub(origin);
    const branch = /@([^/]+)$/.exec(root)?.[1];
    return ref ? sourceOf({ ...ref, branch }) : null;
  } catch {
    return null;
  }
}

const jobs = new Map<string, CloneJob>();
/** The job still running for each checkout folder, so asking twice joins the first clone. */
const running = new Map<string, CloneJob>();

export const cloneJob = (id: string): CloneJob | null => jobs.get(id) ?? null;

/** Starts cloning, or says Docent already has this repo and the user can open it or pull first. */
export function startGithub(ref: GithubRef): GithubStart {
  const dest = checkoutDir(ref);
  const busy = running.get(dest);
  if (busy) return { status: "cloning", job: busy };
  if (existsSync(join(dest, ".git"))) return { status: "exists", repo: `${ref.owner}/${ref.repo}`, path: dest };
  return { status: "cloning", job: start(ref, "clone") };
}

/** Brings Docent's checkout up to date with GitHub. */
export function pullGithub(ref: GithubRef): CloneJob {
  const dest = checkoutDir(ref);
  const busy = running.get(dest);
  if (busy) return busy;
  if (!existsSync(join(dest, ".git"))) throw new Error(`Docent has no copy of ${ref.owner}/${ref.repo} yet`);
  return start(ref, "pull");
}

function start(ref: GithubRef, action: CloneJob["action"]): CloneJob {
  const dest = checkoutDir(ref);
  const job: CloneJob = { id: randomUUID(), repo: `${ref.owner}/${ref.repo}`, action, stage: action === "clone" ? "Connecting to GitHub" : "Checking GitHub for new commits", percent: null, done: false, error: null, path: null };
  jobs.set(job.id, job);
  running.set(dest, job);
  const finish = (error: string | null) => {
    job.done = true;
    job.error = error;
    job.path = error ? null : dest;
    running.delete(dest);
    // Kept a while so a slow poll still sees how it ended.
    setTimeout(() => jobs.delete(job.id), 10 * 60_000).unref();
  };

  if (action === "clone") {
    // Full history, not --depth 1: Docent reads commit messages and what changes together.
    // Into a scratch folder first, so a failed clone never leaves a half checkout that looks reusable.
    mkdirSync(CHECKOUTS, { recursive: true });
    const tmp = join(CHECKOUTS, `.partial-${job.id}`);
    const args = ["clone", "--progress", "--single-branch", "--no-recurse-submodules", ...(ref.branch ? ["--branch", ref.branch] : []), "--", ref.url, tmp];
    void run(job, args, CHECKOUTS).then((stderr) => {
      if (stderr === null) {
        try {
          rmSync(dest, { recursive: true, force: true });
          renameSync(tmp, dest);
          return finish(null);
        } catch (e) {
          rmSync(tmp, { recursive: true, force: true });
          return finish((e as Error).message);
        }
      }
      rmSync(tmp, { recursive: true, force: true });
      finish(explain(stderr, ref));
    });
  } else {
    void run(job, ["pull", "--ff-only", "--progress", "--no-recurse-submodules"], dest).then((stderr) => {
      if (stderr === null) return finish(null);
      finish(/not possible to fast-forward|diverg/i.test(stderr) ? `Docent's copy of ${job.repo} has moved apart from GitHub's, so it can't just pull. Open it as it is, or delete ${dest} and open the URL again.` : explain(stderr, ref));
    });
  }
  return job;
}

let ghPath: string | null | undefined;
/** If the GitHub CLI is installed, git may also ask it for credentials, after the user's own helpers. */
function ghHelper(): string[] {
  if (ghPath === undefined) {
    try {
      ghPath = execFileSync("which", ["gh"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      ghPath = null;
    }
  }
  return ghPath ? ["-c", `credential.https://github.com.helper=!'${ghPath.replace(/'/g, "")}' auth git-credential`] : [];
}

const STAGES: [RegExp, number, number][] = [
  [/counting objects|enumerating objects/i, 0, 3],
  [/compressing objects/i, 3, 6],
  [/receiving objects/i, 6, 86],
  [/resolving deltas/i, 86, 97],
  [/updating files|checking out files/i, 97, 100],
];

/**
 * Runs git with the user's own credentials (credential helper, SSH keys, gh) and never lets it prompt:
 * a prompt would hang the server. Resolves null on success, or what git said on failure.
 */
function run(job: CloneJob, args: string[], cwd: string): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn("git", [...ghHelper(), ...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" },
    });
    const said: string[] = [];
    let pending = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const lines = (pending + chunk).split(/[\r\n]/);
      pending = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/^remote:\s*/, "").trim();
        if (!line) continue;
        const m = /^([A-Za-z ]+):\s+(\d+)%/.exec(line);
        const stage = m && STAGES.find(([re]) => re.test(m[1]!));
        if (m && stage) {
          job.stage = m[1]!.trim();
          job.percent = Math.round(stage[1] + ((stage[2] - stage[1]) * Number(m[2])) / 100);
        } else said.push(line);
      }
    });
    child.on("error", (e) => done(e.message));
    child.on("close", (code) => done(code === 0 ? null : [...said, pending].join("\n")));
  });
}

/** What went wrong, in words that say what to do next. */
export function explain(stderr: string, ref: GithubRef): string {
  const name = `${ref.owner}/${ref.repo}`;
  if (/remote branch .* not found/i.test(stderr)) return `${name} has no branch “${ref.branch}”.`;
  if (/repository not found|not found|could not read username|authentication failed|terminal prompts disabled|permission denied|403|401/i.test(stderr)) {
    return `GitHub didn’t let Docent see ${name}. Either it doesn’t exist, or it’s private and git on this computer isn’t signed in to an account that can see it. Sign in the way you normally use git (a credential helper, SSH keys, or gh auth login), then try again. Docent never asks for or stores a token.`;
  }
  if (/could not resolve host|unable to access|timed out|network is unreachable|connection refused/i.test(stderr)) return "Couldn’t reach GitHub. Check your connection and try again.";
  if (/ENOENT/.test(stderr)) return "git isn’t installed, so Docent can’t clone. Install git and try again.";
  const last = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return `git couldn’t clone ${name}${last ? `: ${last.replace(/^fatal:\s*/, "")}` : "."}`;
}
