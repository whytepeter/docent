import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Docent's own .env (gitignored), at the workspace root. Never the analyzed repo's. */
function envPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml")) && dirname(dir) !== dir) dir = dirname(dir);
  return join(dir, ".env");
}

/**
 * Sets (or with null, clears) one variable in Docent's .env and in this process, so it takes effect
 * without a restart. Every other line, comment and order in the file stays as it was.
 */
export function setEnvVar(name: string, value: string | null): void {
  const file = envPath();
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const line = `${name}=${value ?? ""}`;
  const at = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
  if (at >= 0) lines[at] = line;
  else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, line);
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  if (value) process.env[name] = value;
  else delete process.env[name];
}

/** A key shown back to the page only as its first and last few characters. */
export function hint(value: string | undefined): string | null {
  if (!value) return null;
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-4)}` : "set";
}
