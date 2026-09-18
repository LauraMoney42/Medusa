import { describe, it, expect, vi } from "vitest";
import { TtsStream, type AudioChunk } from "../tts-stream.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A synth whose per-sentence delay is looked up by the sentence's text. */
function delayedSynth(delays: Record<string, number>, fallback = 0) {
  const calls: string[] = [];
  const synthesize = async (text: string) => {
    calls.push(text);
    const ms = delays[text] ?? fallback;
    if (ms > 0) await wait(ms);
    return { audio: Buffer.from(text), mime: "audio/wav" };
  };
  return { synthesize, calls };
}

describe("TtsStream", () => {
  it("emits one ordered chunk per sentence", async () => {
    const chunks: AudioChunk[] = [];
    const { synthesize } = delayedSynth({});
    const stream = new TtsStream({ synthesize, onChunk: (c) => chunks.push(c) });
    stream.push("First one. Second one. ");
    stream.end();
    await wait(20);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(chunks.map((c) => c.text)).toEqual(["First one.", "Second one."]);
    expect(Buffer.from(chunks[0]?.data ?? "", "base64").toString()).toBe("First one.");
  });

  it("keeps chunks in order when the first synth is much slower", async () => {
    const chunks: AudioChunk[] = [];
    const { synthesize, calls } = delayedSynth({ "Slow one.": 60, "Fast one.": 1 });
    const stream = new TtsStream({ synthesize, onChunk: (c) => chunks.push(c) });
    stream.push("Slow one. Fast one. Third one. ");
    stream.end();
    await wait(200);
    expect(chunks.map((c) => c.text)).toEqual(["Slow one.", "Fast one.", "Third one."]);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    // Lookahead of one: sentence 2 started rendering while sentence 1 was still
    // in flight, which is why it was ready the moment sentence 1 was emitted.
    expect(calls.slice(0, 2)).toEqual(["Slow one.", "Fast one."]);
  });

  it("never runs more than 1 + lookahead synths at once", async () => {
    let live = 0;
    let peak = 0;
    const synthesize = async (text: string) => {
      live++;
      peak = Math.max(peak, live);
      await wait(10);
      live--;
      return { audio: Buffer.from(text), mime: "audio/wav" };
    };
    const stream = new TtsStream({ synthesize, onChunk: () => undefined, lookahead: 1 });
    stream.push("A one. B two. C three. D four. E five. ");
    stream.end();
    await wait(200);
    expect(peak).toBe(2);
  });

  it("fires onStart once and onEnd after the last chunk", async () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const { synthesize } = delayedSynth({});
    const stream = new TtsStream({
      synthesize,
      onChunk: () => undefined,
      onStart,
      onEnd,
    });
    stream.push("One. Two. ");
    expect(onEnd).not.toHaveBeenCalled();
    stream.end();
    await wait(30);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("cancel() drops the queue and discards in-flight audio", async () => {
    const chunks: AudioChunk[] = [];
    const { synthesize } = delayedSynth({ "One.": 50 }, 5);
    const stream = new TtsStream({ synthesize, onChunk: (c) => chunks.push(c) });
    stream.push("One. Two. Three. ");
    stream.cancel();
    await wait(120);
    expect(chunks).toHaveLength(0);
    stream.push("Ignored. ");
    await wait(20);
    expect(chunks).toHaveLength(0);
  });

  it("reports a synth failure and keeps speaking the rest", async () => {
    const chunks: AudioChunk[] = [];
    const onError = vi.fn();
    const synthesize = async (text: string) => {
      if (text.startsWith("Bad")) throw new Error("kokoro down");
      return { audio: Buffer.from(text), mime: "audio/wav" };
    };
    const stream = new TtsStream({ synthesize, onChunk: (c) => chunks.push(c), onError });
    stream.push("Bad one. Good one. ");
    stream.end();
    await wait(30);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(chunks.map((c) => c.text)).toEqual(["Good one."]);
  });

  it("tracks the last spoken sentence for the barge-in prefix", async () => {
    const { synthesize } = delayedSynth({});
    const stream = new TtsStream({ synthesize, onChunk: () => undefined });
    stream.push("First one. Second one. ");
    await wait(20);
    expect(stream.lastSpokenSentence).toBe("Second one.");
  });

  it("does not synthesize markdown furniture", async () => {
    const { synthesize, calls } = delayedSynth({});
    const stream = new TtsStream({ synthesize, onChunk: () => undefined });
    stream.push("Here it is.\n```ts\nconst x = 1;\n```\nAll done. ");
    stream.end();
    await wait(30);
    expect(calls.join(" ")).not.toContain("const x");
    expect(calls).toContain("All done.");
  });
});
