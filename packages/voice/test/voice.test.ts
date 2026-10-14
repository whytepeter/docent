import { describe, expect, it } from "vitest";
import { clipAudio, clipHash, DEFAULT_PRONUNCIATIONS, estimateWords, pronounce, wav } from "../src/index.ts";

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
  it("says terms the table's way, whole words only", () => {
    expect(pronounce("The JPEG and the PDF get a SHA-256 each.", DEFAULT_PRONUNCIATIONS)).toBe("The jay-peg and the P D F get a shah two fifty-six each.");
    expect(pronounce("JPEGs and PDFish stay as written", DEFAULT_PRONUNCIATIONS)).toBe("JPEGs and PDFish stay as written");
    expect(pronounce("Ask the API", { API: "A P I" })).toBe("Ask the A P I");
  });
  it("spreads words over a clip in order when a provider gives no timings", () => {
    const words = estimateWords("one two three", 3);
    expect(words.map((w) => w.word)).toEqual(["one", "two", "three"]);
    expect(words[0]!.start).toBeLessThan(words[1]!.start);
    expect(words.at(-1)!.end).toBeLessThanOrEqual(3);
  });
});
