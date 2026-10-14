import { describe, expect, it } from "vitest";
import { hasSecret, redact } from "../src/redact.ts";

describe("redaction", () => {
  it("removes real-looking secrets", () => {
    // Made-up keys, assembled from parts so secret scanners don't mistake this test for a leak.
    const k = (...parts: string[]) => parts.join("");
    const text = [
      `ANTHROPIC_API_KEY=${k("sk-ant-", "api03-", "abcdefghijklmnopqrstuvwxyz012345")}`,
      `token ${k("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789AB")}`,
      `aws ${k("AKIA", "IOSFODNN7EXAMPLE")}`,
      "db postgres://app:hunter2secret@db.example.com:5432/app",
      'const CLIENT_SECRET = "s3cr3t-value-123";',
      `jwt ${k("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")}`,
      `cartesia ${k("sk_", "car_", "ABCDEFGHIJKLMNOPQRSTUV")}`,
      k("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEow\n-----END RSA ", "PRIVATE KEY-----"),
    ].join("\n");
    const out = redact(text);
    for (const leaked of ["sk-ant-api03", "ghp_abc", "AKIAIOSFODNN7EXAMPLE", "hunter2secret", "s3cr3t-value", "eyJhbGci", "sk_car_ABC", "MIIEow"]) expect(out).not.toContain(leaked);
    expect(out).toContain("postgres://app:[redacted]@db.example.com");
    expect(out).toContain("CLIENT_SECRET = \"[redacted]");
  });
  it("leaves ordinary code alone", () => {
    const code = [
      "const token = await getToken();",
      "const API_KEY = process.env.API_KEY;",
      "headers: { Authorization: `Bearer ${token}` },",
      "const SESSION_TOKEN_TTL = 3600;",
      "if (password.length < 8) return 'too short';",
      "const skip = items.filter((sk) => sk.ready);",
    ].join("\n");
    expect(redact(code)).toBe(code);
    expect(hasSecret(code)).toBe(false);
  });
});
