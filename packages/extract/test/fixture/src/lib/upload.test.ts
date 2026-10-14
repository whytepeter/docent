import { describe, expect, it } from "vitest";
import { upload } from "./upload";

describe("upload", () => {
  it("posts the file", () => {
    expect(upload("x")).toBe("X");
  });
});
