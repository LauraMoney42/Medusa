/**
 * S16 item 3: the first chunk of a reply is cut at a clause boundary so the
 * first audio request is small, and everything after it goes back to whole
 * sentences.
 */

import { describe, expect, it, vi } from "vitest";
import {
  FIRST_CLAUSE_CHARS,
  findClauseEnd,
  MAX_SENTENCE_CHARS,
  SentenceChunker,
} from "../sentence-chunker.js";
import { TtsStream } from "../tts-stream.js";

describe("findClauseEnd", () => {
  it("cuts after a comma, semicolon or colon followed by a space", () => {
    expect("Sure, ".slice(0, findClauseEnd("Sure, I can do that."))).toBe("Sure,");
    expect("Yes; ".slice(0, findClauseEnd("Yes; here it is."))).toBe("Yes;");
    expect("Three files: ".slice(0, findClauseEnd("Three files: a, b and c."))).toBe(
      "Three files:"
    );
  });

  it("leaves numbers and hyphenated words alone", () => {
    expect(findClauseEnd("3,500 lines of code in there")).toBe(-1);
    expect(findClauseEnd("a state-of-the-art parser is here")).toBe(-1);
  });

  it("waits for the character after the punctuation", () => {
    expect(findClauseEnd("Sure,")).toBe(-1);
  });

  it("never looks past the cap", () => {
    const text = `${"x".repeat(80)}, and the rest`;
    expect(findClauseEnd(text, 60)).toBe(-1);
  });
});

describe("SentenceChunker in first-clause mode", () => {
  it("speaks the opening clause without waiting for the sentence", () => {
    const chunker = new SentenceChunker(MAX_SENTENCE_CHARS, {
      firstClauseChars: FIRST_CLAUSE_CHARS,
    });
    expect(chunker.push("Sure, ")).toEqual(["Sure,"]);
    // After the first chunk it is sentence boundaries again: a second comma
    // does not split.
    expect(chunker.push("there are three files, all TypeScript")).toEqual([]);
    expect(chunker.push(". Want the list?")).toEqual([
      "there are three files, all TypeScript.",
    ]);
  });

  it("cuts a long opening run at the clause cap", () => {
    const chunker = new SentenceChunker(MAX_SENTENCE_CHARS, { firstClauseChars: 60 });
    const long = "I looked through every file under the server directory and found nothing unusual at all.";
    const out = chunker.push(long);
    expect(out).toHaveLength(1);
    expect((out[0] as string).length).toBeLessThanOrEqual(60);
  });

  it("still ends on the sentence when it comes before the clause", () => {
    const chunker = new SentenceChunker(MAX_SENTENCE_CHARS, { firstClauseChars: 60 });
    expect(chunker.push("Done. Anything else, or shall I stop?")).toEqual(["Done."]);
  });

  it("behaves exactly as before when the mode is off", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Sure, there are three files. ")).toEqual([
      "Sure, there are three files.",
    ]);
  });

  it("goes back to clause mode for the next turn after a reset", () => {
    const chunker = new SentenceChunker(MAX_SENTENCE_CHARS, { firstClauseChars: 60 });
    expect(chunker.push("Sure, ")).toEqual(["Sure,"]);
    chunker.reset();
    expect(chunker.push("Right, ")).toEqual(["Right,"]);
  });
});

describe("TtsStream first-chunk latency", () => {
  it("sends the opening clause to the synthesizer before the sentence ends", async () => {
    const asked: string[] = [];
    const chunks: string[] = [];
    const stream = new TtsStream({
      synthesize: async (text) => {
        asked.push(text);
        return { audio: Buffer.from(text), mime: "audio/wav" };
      },
      onChunk: (c) => chunks.push(c.text),
    });

    stream.push("Sure, ");
    await new Promise((r) => setTimeout(r, 5));
    expect(asked[0]).toBe("Sure,");
    expect(chunks[0]).toBe("Sure,");

    stream.push("there are three files in that folder. ");
    stream.end();
    await new Promise((r) => setTimeout(r, 5));
    expect(asked[1]).toBe("there are three files in that folder.");
  });

  it("can be put back into whole-sentence mode", async () => {
    const asked: string[] = [];
    const stream = new TtsStream({
      firstClauseChars: 0,
      synthesize: async (text) => {
        asked.push(text);
        return { audio: Buffer.from(text), mime: "audio/wav" };
      },
      onChunk: vi.fn(),
    });
    stream.push("Sure, there are three files. ");
    await new Promise((r) => setTimeout(r, 5));
    expect(asked).toEqual(["Sure, there are three files."]);
  });
});
