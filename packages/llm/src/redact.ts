/**
 * Secrets that must never reach Claude, a voice provider, or anything Docent shows or stores.
 * High-precision patterns only: a missed secret is bad, but so is mangling ordinary code.
 */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-(?:ant-|proj-|fish)?[A-Za-z0-9_-]{20,}\b/g, // Anthropic, OpenAI, Fish Audio
  /\b(?:sk|rk|pk)_(?:live|test|car)_[A-Za-z0-9]{16,}\b/g, // Stripe, Cartesia
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
];
/** user:password@ in a connection string: only the password goes. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})@/gi;
/** API_KEY = "…", CLIENT_SECRET: '…': the name stays, a literal value goes. References like process.env.X stay. */
const ASSIGNED = /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[:=]\s*["'`]?)([^\s"'`,;)]{8,})/g;
const REFERENCE = /^(?:process\.env|import\.meta|env\.|\$\{|\$[A-Z_])/;

export const REDACTED = "[redacted]";

export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, REDACTED);
  out = out.replace(URL_PASSWORD, `$1${REDACTED}@`);
  out = out.replace(ASSIGNED, (m, name: string, sep: string, value: string) => (REFERENCE.test(value) || value === REDACTED ? m : `${name}${sep}${REDACTED}`));
  return out;
}

export const hasSecret = (text: string) => redact(text) !== text;
