import { describe, expect, it } from "vitest";
import { clipAudio, clipHash, wav } from "../src/index.ts";

describe("voice", () => {
  it("wraps PCM in a playable WAV header", () => {
    const out = Buffer.from(wav(new Uint8Array(4800), 24000));
    expect(out.toString("ascii", 0, 4)).toBe("RIFF");
    expect(out.toString("ascii", 8, 12)).toBe("WAVE");
    expect(out.readUInt32LE(24)).toBe(24000);
    expect(out.readUInt32LE(40)).toBe(4800);
  });
  it("hashes text, provider and voice, so one changed sentence means one new clip", () => {
    expect(clipHash("a", "cartesia", "v")).not.toBe(clipHash("b", "cartesia", "v"));
    expect(clipHash("a", "cartesia", "v")).not.toBe(clipHash("a", "cartesia", "w"));
    expect(clipHash("a", "cartesia", "v")).toMatch(/^[0-9a-f]{24}$/);
  });
  it("never reads outside the clip cache", () => {
    expect(clipAudio("../../etc/passwd")).toBeNull();
    expect(clipAudio("abc")).toBeNull();
  });
});
