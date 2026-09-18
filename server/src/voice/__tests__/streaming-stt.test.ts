import { describe, expect, it, vi } from "vitest";
import {
  ROLLING_DEFAULTS,
  RollingWindowSttProvider,
  RollingWindowSttSession,
} from "../streaming-stt.js";
import { SttStream } from "../stt-stream.js";
import type { SttProvider } from "../providers.js";

const SAMPLE_RATE = 16_000;

function tone(ms: number, amplitude = 8000): Int16Array {
  const n = Math.round((SAMPLE_RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE));
  }
  return out;
}

function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
}

/** A one-shot provider whose answer grows with the audio it is given. */
function growingProvider(): SttProvider & { calls: number[] } {
  const calls: number[] = [];
  return {
    id: "fake",
    supportsPartials: false,
    isReady: () => true,
    calls,
    async transcribe(pcm: Int16Array) {
      calls.push(pcm.length);
      const words = Math.max(1, Math.round((pcm.length / SAMPLE_RATE) * 2));
      return Array.from({ length: words }, (_, i) => `word${i + 1}`).join(" ");
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("RollingWindowSttSession", () => {
  it("emits a partial no more often than the interval", async () => {
    const provider = growingProvider();
    const partials: string[] = [];
    let now = 1000;
    const session = new RollingWindowSttSession(
      provider,
      { onPartial: (t) => partials.push(t) },
      { now: () => now }
    );

    // 100 ms frames, the cadence the client actually sends. Nothing is
    // transcribed inside the first interval.
    for (let i = 0; i < 7; i++) {
      session.push(tone(100));
      await flush();
      now += 100;
    }
    expect(provider.calls).toHaveLength(0);

    // The frame that crosses 700 ms since the last run triggers one window.
    session.push(tone(100));
    await flush();
    expect(provider.calls).toHaveLength(1);
    expect(partials).toHaveLength(1);

    // ... and the next one does not, until another interval has passed.
    now += 100;
    session.push(tone(100));
    await flush();
    expect(provider.calls).toHaveLength(1);

    now += 700;
    session.push(tone(100));
    await flush();
    expect(provider.calls).toHaveLength(2);
    // Each window sees the whole utterance so far, so it grows.
    expect(provider.calls[1]).toBeGreaterThan(provider.calls[0] as number);
    expect(partials[1]).not.toBe(partials[0]);
  });

  it("does not transcribe less than the minimum audio", async () => {
    const provider = growingProvider();
    let now = 0;
    const session = new RollingWindowSttSession(provider, {}, { now: () => now });
    session.push(tone(100));
    now += 5_000;
    session.push(tone(100));
    await flush();
    // 200 ms of audio, under the 300 ms floor.
    expect(provider.calls).toHaveLength(0);
  });

  it("stops producing partials once the utterance passes the cap", async () => {
    const provider = growingProvider();
    let now = 0;
    const session = new RollingWindowSttSession(provider, {}, { now: () => now });
    session.push(tone(500));
    await flush();
    now += ROLLING_DEFAULTS.maxUtteranceMs + 1000;
    session.push(tone(500));
    await flush();
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps one request in flight at a time", async () => {
    let resolve: ((text: string) => void) | null = null;
    const provider: SttProvider = {
      id: "slow",
      supportsPartials: false,
      isReady: () => true,
      transcribe: () => new Promise<string>((r) => (resolve = r)),
    };
    const seen: string[] = [];
    let now = 0;
    const session = new RollingWindowSttSession(
      provider,
      { onPartial: (t) => seen.push(t) },
      { now: () => now }
    );
    session.push(tone(400));
    await flush();
    now += 800;
    session.push(tone(400));
    await flush();
    // One window is rendering; the next frame must not start a second one.
    now += 800;
    session.push(tone(400));
    await flush();
    expect(seen).toHaveLength(0);
    resolve!("hello there");
    await flush();
    expect(seen).toEqual(["hello there"]);
  });

  it("swallows a failed partial rather than failing the turn", async () => {
    const provider: SttProvider = {
      id: "broken",
      supportsPartials: false,
      isReady: () => true,
      transcribe: async () => {
        throw new Error("whisper is down");
      },
    };
    const onError = vi.fn();
    let now = 0;
    const session = new RollingWindowSttSession(provider, { onError }, { now: () => now });
    session.push(tone(400));
    now += 800;
    session.push(tone(400));
    await new Promise((r) => setTimeout(r, 10));
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("SttStream partials", () => {
  it("emits growing partials while speaking, then the final transcript", async () => {
    const provider = growingProvider();
    const partials: string[] = [];
    const finals: string[] = [];
    const stream = new SttStream({
      provider,
      partials: new RollingWindowSttProvider(provider, { intervalMs: 200 }),
      onPartial: (t) => partials.push(t),
      onTranscript: (t) => finals.push(t),
    });

    // Speech long enough for several partial windows, then silence to close it.
    for (let i = 0; i < 10; i++) {
      stream.pushAudio(tone(100));
      await new Promise((r) => setTimeout(r, 25));
    }
    stream.pushAudio(silence(800));
    await new Promise((r) => setTimeout(r, 30));

    expect(partials.length).toBeGreaterThan(0);
    expect(stream.lastPartial).toBe("");
    expect(finals).toHaveLength(1);
  });

  it("emits nothing while speaking when no partial provider is configured", async () => {
    const provider = growingProvider();
    const partials: string[] = [];
    const stream = new SttStream({ provider, onPartial: (t) => partials.push(t) });
    for (let i = 0; i < 10; i++) {
      stream.pushAudio(tone(100));
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(partials).toHaveLength(0);
  });
});
