import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Files no provider may open: secret-bearing files, and agent session folders, which are full of
 * pasted keys and tokens and would leave the machine unredacted. Globs relative to the repo root.
 */
export const SECRET_FILES = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa*", "**/id_ed25519*", "**/.npmrc", "**/.netrc",
  "**/.wolf/**", "**/.claude/**", "**/.cursor/**", "**/.codex/**", "**/.agents/**",
];

/** Folders in the home directory that hold credentials, for providers whose sandbox can see outside the repo. */
export const SECRET_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".codex", ".claude", ".gemini"];

/**
 * Docent's own .env (API keys pasted in Settings). Never the analyzed repo's. Run from a checkout of Docent's
 * source, it's the one at the checkout's root; installed from npm, it's ~/.docent/.env.
 */
export const DOCENT_ENV = docentEnv();

function docentEnv(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && isDocent(join(dir, "package.json"))) return join(dir, ".env");
  }
  return join(homedir(), ".docent", ".env");
}

function isDocent(packageJson: string): boolean {
  try {
    return (JSON.parse(readFileSync(packageJson, "utf8")) as { name?: string }).name === "docent";
  } catch {
    return false;
  }
}

/** Puts the keys in Docent's .env into this process, if there is one. */
export function loadDocentEnv(): void {
  if (existsSync(DOCENT_ENV)) process.loadEnvFile(DOCENT_ENV);
}
