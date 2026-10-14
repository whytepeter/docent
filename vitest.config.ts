import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/*/test/**/*.test.ts"], exclude: ["**/fixture/**", "**/node_modules/**"] },
});
