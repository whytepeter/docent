import { describe, expect, it } from "vitest";
import { KokoroAdapter, phonemePieces } from "../src/kokoro.ts";

describe("kokoro", () => {
  it("tags every phoneme piece with the word it says, so timings map back to the text", async () => {
    const { words, pieces } = await phonemePieces("The upload goes to S3, then 256 checks run.", false);
    expect(words).toEqual(["The", "upload", "goes", "to", "S3", "then", "256", "checks", "run"]);
    // Every word gets phonemes, in order; pauses and spaces belong to no word.
    const said = [...new Set(pieces.filter((p) => p.word >= 0).map((p) => p.word))];
    expect(said).toEqual(words.map((_, i) => i));
    expect(pieces.some((p) => p.word === -1 && p.p.includes(","))).toBe(true);
  });
  it("lists its voices and finds them by name or accent", async () => {
    const a = new KokoroAdapter();
    expect((await a.listVoices()).length).toBe(28);
    expect((await a.listVoices({ query: "british male" })).every((v) => v.description?.startsWith("British · Male"))).toBe(true);
    expect((await a.listVoices({ query: "heart" }))[0]?.id).toBe("af_heart");
  });
});
