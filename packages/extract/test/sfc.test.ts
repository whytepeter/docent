import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extract, type Facts } from "../src/index.ts";
import { autoImportNames, scriptView, templateRefs } from "../src/sfc.ts";

describe("Vue and Svelte components", () => {
  let facts: Facts;
  const edge = (from: string, to: string, kind = "calls") => facts.edges.find((e) => e.from === from && e.to === to && e.kind === kind);

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), "docent-sfc-"));
    cpSync(join(import.meta.dirname, "fixture-sfc"), root, { recursive: true });
    facts = extract(root);
  });

  it("keeps script lines where they are in the file", () => {
    const text = "<template>\n  <p>{{ a }}</p>\n</template>\n<script setup>\nconst a = 1;\n</script>\n<style>p{}</style>\n";
    const view = scriptView(text);
    expect(view.split("\n")).toHaveLength(text.split("\n").length);
    expect(view.split("\n")[4]).toBe("const a = 1;");
    expect(view).not.toMatch(/template|style|script|\{\{/);
  });

  it("makes each component a symbol, with its script's functions in the same file", () => {
    const ids = facts.symbols.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([
      "src/App.vue#App", "src/App.vue#reset", "src/components/UserCard.vue#UserCard", "src/components/UserCard.vue#save",
      "src/svelte/Counter.svelte#Counter", "src/svelte/Counter.svelte#increment", "src/svelte/Button.svelte#Button",
    ]));
    expect(facts.symbols.find((s) => s.id === "src/App.vue#reset")!.range).toEqual({ start: 22, end: 24 });
  });

  it("resolves imports of components, through relative paths and the @/ alias", () => {
    const to = (from: string) => facts.imports.filter((i) => i.from === from && !i.external).map((i) => i.to);
    expect(to("src/main.ts")).toContain("src/App.vue");
    expect(to("src/App.vue")).toEqual(expect.arrayContaining(["src/components/UserCard.vue", "src/lib/api.ts"]));
    expect(to("src/svelte/Counter.svelte")).toContain("src/svelte/Button.svelte");
  });

  it("links script calls out of a component", () => {
    expect(edge("src/components/UserCard.vue#save", "src/lib/api.ts#saveUser")?.confidence).toBe("confirmed");
  });

  it("reads the template: components it renders and functions its handlers use", () => {
    expect(edge("src/App.vue#App", "src/components/UserCard.vue#UserCard", "renders")).toMatchObject({ line: 4, confidence: "confirmed" });
    expect(edge("src/App.vue#App", "src/App.vue#reset")).toMatchObject({ line: 6, confidence: "confirmed" });
    expect(edge("src/App.vue#App", "src/App.vue#onSaved")).toBeTruthy();
    expect(edge("src/App.vue#App", "src/lib/api.ts#formatName")).toBeTruthy();
    expect(edge("src/components/UserCard.vue#UserCard", "src/components/UserCard.vue#save")).toBeTruthy();
    expect(edge("src/svelte/Counter.svelte#Counter", "src/svelte/Button.svelte#Button", "renders")).toMatchObject({ line: 13 });
    expect(edge("src/svelte/Counter.svelte#Counter", "src/svelte/Counter.svelte#increment")).toBeTruthy();
  });

  it("matches an auto-imported component by name, labeled inferred, and doesn't call it unused", () => {
    expect(edge("src/App.vue#App", "src/components/AutoBadge.vue#AutoBadge", "renders")?.confidence).toBe("inferred");
    expect(facts.unreferenced.map((u) => u.file)).not.toContain("src/components/AutoBadge.vue");
  });

  it("ignores commented-out markup and plain HTML tags", () => {
    const { tags } = templateRefs("vue", "<template>\n<!-- <OldCard /> -->\n<div><span/></div>\n</template>");
    expect(tags.map((t) => t.name)).toEqual(["div", "span"]);
    expect(facts.edges.some((e) => e.to.includes("OldCard"))).toBe(false);
  });

  it("detects Vue, Svelte and Angular, and doesn't warn about them as unparsed", () => {
    expect(facts.stack).toEqual(expect.arrayContaining(["Vue", "Svelte", "Angular"]));
    expect(facts.warnings.join(" ")).not.toMatch(/not parsed/);
  });

  it("names auto-imported components the way Nuxt does", () => {
    expect(autoImportNames("app/components/base/radio-group/RadioGroupItem.vue")).toContain("BaseRadioGroupItem");
    expect(autoImportNames("components/base/BaseButton.vue")).toEqual(["BaseButton"]);
    expect(autoImportNames("app/components/layout/sidebar/Index.vue")).toEqual(["Sidebar", "LayoutSidebar"]);
  });
});
