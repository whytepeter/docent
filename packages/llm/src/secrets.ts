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

/** Docent's own .env (API keys pasted in Settings), at the root of this workspace. */
export const DOCENT_ENV = fileURLToPath(new URL("../../../.env", import.meta.url));
