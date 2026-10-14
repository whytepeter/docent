import { describe, expect, it } from "vitest";
import { areaOf } from "./areas.ts";

describe("areas", () => {
  it("names a monorepo package's src root after the package, and merges it with the package's other folders", () => {
    expect(areaOf("packages/llm/src/index.ts")).toMatchObject({ id: "packages/llm", label: "Llm", group: "packages" });
    expect(areaOf("packages/llm/test/redact.test.ts")).toMatchObject({ id: "packages/llm" });
    expect(areaOf("apps/web/src/main.tsx")).toMatchObject({ id: "apps/web", label: "Web", group: "apps" });
  });
  it("keeps a single app's src root as the top level, and folders as units", () => {
    expect(areaOf("src/main.tsx")).toMatchObject({ id: "src", label: "Top level" });
    expect(areaOf("vite.config.ts")).toMatchObject({ id: ".", label: "Top level" });
    expect(areaOf("src/features/document-upload/a.tsx")).toMatchObject({ id: "src/features/document-upload", label: "Document upload", group: "features" });
    expect(areaOf("apps/web/src/features/ask/AskPanel.tsx")).toMatchObject({ id: "apps/web/src/features/ask", label: "Ask", group: "features" });
  });
});
