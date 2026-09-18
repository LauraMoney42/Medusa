import { describe, it, expect } from "vitest";
import {
  SentenceChunker,
  MAX_SENTENCE_CHARS,
  findSentenceEnd,
  speakableText,
} from "../sentence-chunker.js";

/** Feed a whole string as one delta plus a flush, like a finished turn. */
function chunkAll(text: string, maxChars?: number): string[] {
  const chunker = new SentenceChunker(maxChars);
  return [...chunker.push(text), ...chunker.flush()];
}

describe("findSentenceEnd", () => {
  it("waits for the character after a terminator before committing", () => {
    expect(findSentenceEnd("Hello there.")).toBe(-1);
    expect(findSentenceEnd("Hello there. ")).toBe(12);
    expect(findSentenceEnd("Hello there.", true)).toBe(12);
  });

  it("treats a newline as a boundary", () => {
    expect(findSentenceEnd("A list:\nfirst")).toBe(8);
  });
});

describe("SentenceChunker", () => {
  it("splits on terminators", () => {
    expect(chunkAll("One. Two! Three? Four")).toEqual(["One.", "Two!", "Three?", "Four"]);
  });

  it("does not split on abbreviations", () => {
    expect(chunkAll("Dr. Smith is here. Yes.")).toEqual(["Dr. Smith is here.", "Yes."]);
    expect(chunkAll("Use e.g. this one. Done.")).toEqual(["Use e.g. this one.", "Done."]);
    expect(chunkAll("It ships vs. the old one. Fine.")).toEqual([
      "It ships vs. the old one.",
      "Fine.",
    ]);
    expect(chunkAll("Built in the U.S. mostly. Right.")).toEqual([
      "Built in the U.S. mostly.",
      "Right.",
    ]);
    expect(chunkAll("Ask J. Random first. OK.")).toEqual(["Ask J. Random first.", "OK."]);
  });

  it("does not split inside decimals or filenames", () => {
    expect(chunkAll("Version 3.5 is out. Good.")).toEqual(["Version 3.5 is out.", "Good."]);
    expect(chunkAll("Open server/src/index.ts now. Done.")).toEqual([
      "Open server/src/index.ts now.",
      "Done.",
    ]);
  });

  it("caps a terminator-free run at 180 characters, on a word boundary", () => {
    const long = "word ".repeat(80).trim(); // 399 chars, no terminator
    const chunks = chunkAll(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
    // Nothing is lost or duplicated by the cut.
    expect(chunks.join(" ")).toBe(long);
    expect(chunks[0]?.endsWith("word")).toBe(true);
  });

  it("caps an over-long sentence even when a terminator exists past the cap", () => {
    const chunks = chunkAll(`${"alpha ".repeat(60)}end.`);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
    expect(chunks[chunks.length - 1]?.endsWith("end.")).toBe(true);
  });

  it("emits a sentence as soon as the stream crosses the boundary", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Hello")).toEqual([]);
    expect(chunker.push(" there.")).toEqual([]); // terminator, nothing after it yet
    expect(chunker.push(" Next")).toEqual(["Hello there."]);
    expect(chunker.flush()).toEqual(["Next"]);
  });

  it("holds an abbreviation that lands on a delta boundary", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Call Mr.")).toEqual([]);
    expect(chunker.push(" Smith about it. ")).toEqual(["Call Mr. Smith about it."]);
  });

  it("reset() drops the buffer for barge-in", () => {
    const chunker = new SentenceChunker();
    chunker.push("Half a sentence");
    chunker.reset();
    expect(chunker.flush()).toEqual([]);
  });

  it("respects a custom cap", () => {
    for (const c of chunkAll("a ".repeat(60), 40)) expect(c.length).toBeLessThanOrEqual(40);
  });
});

describe("speakableText", () => {
  it("strips code fences, table rows and markdown furniture", () => {
    const out = speakableText("## Title\n- **bold** item\n```ts\nconst x = 1;\n```\n| a | b |");
    expect(out).not.toContain("const x");
    expect(out).not.toContain("**");
    expect(out).not.toContain("##");
    expect(out).toContain("bold item");
  });
});
