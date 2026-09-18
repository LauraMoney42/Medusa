import { describe, it, expect, vi } from "vitest";
import { VoiceSession, interruptionPrefix, type VoiceSessionDeps } from "../session.js";
import type { SttProvider, TtsProvider } from "../providers.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
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

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface Harness {
  session: VoiceSession;
  events: { event: string; payload: Record<string, unknown> }[];
  sent: string[];
  abort: ReturnType<typeof vi.fn>;
  activity: string[];
  setBusy(busy: boolean): void;
  eventsOf(name: string): Record<string, unknown>[];
  states(): string[];
}

function harness(opts: { transcript?: string; synthDelayMs?: number } = {}): Harness {
  const events: Harness["events"] = [];
  const sent: string[] = [];
  const activity: string[] = [];
  const abort = vi.fn();
  let busy = false;

  const stt: SttProvider = {
    id: "fake-stt",
    supportsPartials: false,
    isReady: () => true,
    transcribe: async () => opts.transcript ?? "what files are in this folder",
  };
  const tts: TtsProvider = {
    id: "fake-tts",
    isReady: () => true,
    synthesize: async (text) => {
      if (opts.synthDelayMs) await wait(opts.synthDelayMs);
      return { audio: Buffer.from(text), mime: "audio/wav" };
    },
  };

  const deps: VoiceSessionDeps = {
    sessionId: "s1",
    emit: (event, payload) => events.push({ event, payload }),
    activity: (summary) => activity.push(summary),
    send: (text) => sent.push(text),
    abortTurn: abort,
    isBusy: () => busy,
    stt,
    tts,
  };

  const session = new VoiceSession(deps);
  return {
    session,
    events,
    sent,
    abort,
    activity,
    setBusy: (b) => {
      busy = b;
    },
    eventsOf: (name) => events.filter((e) => e.event === name).map((e) => e.payload),
    states: () =>
      events.filter((e) => e.event === "voice:state").map((e) => e.payload.state as string),
  };
}

/** Speak one utterance into the session and let the transcript settle. */
async function speak(h: Harness): Promise<void> {
  h.session.pushAudio(concat(silence(100), tone(400), silence(800)));
  await wait(20);
}

describe("VoiceSession state machine", () => {
  it("walks idle -> listening -> transcribing -> thinking -> speaking -> listening", async () => {
    const h = harness();
    expect(h.session.currentState).toBe("idle");
    h.session.start("always-on");
    expect(h.session.currentState).toBe("listening");

    await speak(h);
    expect(h.sent).toEqual(["what files are in this folder"]);
    expect(h.session.currentState).toBe("thinking");

    h.session.onStreamStart();
    h.session.onDelta("Three files. ");
    await wait(20);
    expect(h.session.currentState).toBe("speaking");

    h.session.onStreamEnd();
    await wait(20);
    expect(h.session.currentState).toBe("listening");

    expect(h.states()).toEqual([
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "listening",
    ]);
  });

  it("emits the transcript with a messageId before sending the turn", async () => {
    const h = harness({ transcript: "hello there" });
    h.session.start();
    await speak(h);
    const [transcript] = h.eventsOf("voice:transcript");
    expect(transcript).toMatchObject({ sessionId: "s1", text: "hello there" });
    expect(typeof transcript?.messageId).toBe("string");
    expect(h.sent).toEqual(["hello there"]);
  });

  it("emits ordered audio chunks plus speaking-start/end", async () => {
    const h = harness();
    h.session.start();
    await speak(h);
    h.session.onStreamStart();
    h.session.onDelta("One sentence. Two sentences. ");
    h.session.onStreamEnd();
    await wait(30);
    expect(h.eventsOf("voice:speaking-start")).toHaveLength(1);
    expect(h.eventsOf("voice:audio-chunk").map((c) => c.seq)).toEqual([0, 1]);
    expect(h.eventsOf("voice:speaking-end")).toHaveLength(1);
  });

  it("reports one voice:latency per turn with the four stage timings", async () => {
    const h = harness();
    h.session.start();
    await speak(h);
    h.session.onStreamStart();
    h.session.onDelta("Done. ");
    h.session.onStreamEnd();
    await wait(30);
    const latency = h.eventsOf("voice:latency");
    expect(latency).toHaveLength(1);
    expect(latency[0]).toHaveProperty("sttMs");
    expect(latency[0]).toHaveProperty("firstTokenMs");
    expect(latency[0]).toHaveProperty("firstAudioMs");
    expect(latency[0]).toHaveProperty("totalMs");
    expect(h.activity.some((a) => a.includes("to first word"))).toBe(true);
  });

  it("ignores audio before start() and after stop()", async () => {
    const h = harness();
    h.session.pushAudio(concat(tone(400), silence(800)));
    await wait(20);
    expect(h.sent).toHaveLength(0);

    h.session.start();
    h.session.stop();
    expect(h.session.currentState).toBe("idle");
    h.session.pushAudio(concat(tone(400), silence(800)));
    await wait(20);
    expect(h.sent).toHaveLength(0);
  });

  it("returns to listening when the turn errors before any text", async () => {
    const h = harness();
    h.session.start();
    await speak(h);
    h.session.onStreamError();
    expect(h.session.currentState).toBe("listening");
  });
});

describe("VoiceSession barge-in", () => {
  it("stops audio, aborts the turn, and re-prompts with the interruption prefix", async () => {
    const h = harness({ transcript: "actually, never mind" });
    h.session.start();

    // Turn one: she is mid-reply and the engine is still streaming.
    h.session.onStreamStart();
    h.session.onDelta("The folder has three files. ");
    await wait(20);
    expect(h.session.currentState).toBe("speaking");
    h.setBusy(true);

    // The user talks over her.
    await speak(h);

    expect(h.eventsOf("voice:stop-audio").length).toBeGreaterThanOrEqual(1);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toBe(
      `${interruptionPrefix("The folder has three files.")}actually, never mind`
    );
    expect(h.eventsOf("voice:speaking-end")).toHaveLength(1);
  });

  it("stops playback once the onset sustains past the barge-in bar, before the transcript exists", async () => {
    const h = harness({ synthDelayMs: 5 });
    h.session.start();
    h.session.onStreamStart();
    h.session.onDelta("A long answer that keeps going. ");
    await wait(30);
    expect(h.eventsOf("voice:stop-audio")).toHaveLength(0);

    // A loud, sustained onset (well past the 300 ms bar): no silence yet, so
    // no transcript can exist, but playback should already have stopped.
    h.session.pushAudio(concat(silence(60), tone(320)));
    expect(h.eventsOf("voice:stop-audio")).toHaveLength(1);
    expect(h.abort).not.toHaveBeenCalled();
  });

  it("does NOT stop playback for a short or weak onset (her own echo)", async () => {
    const h = harness({ synthDelayMs: 5 });
    h.session.start();
    h.session.onStreamStart();
    h.session.onDelta("A long answer that keeps going. ");
    await wait(30);

    // A brief loud click, well under the 300 ms sustain bar.
    h.session.pushAudio(concat(silence(60), tone(60)));
    expect(h.eventsOf("voice:stop-audio")).toHaveLength(0);

    // A quiet, sustained onset (below the 2000 default bar): typical
    // playback leaking back through laptop speakers.
    h.session.pushAudio(concat(silence(600), tone(400, 1200)));
    expect(h.eventsOf("voice:stop-audio")).toHaveLength(0);
    expect(h.abort).not.toHaveBeenCalled();
  });

  it("interrupt() stops audio and aborts a busy turn", async () => {
    const h = harness();
    h.session.start();
    h.session.onStreamStart();
    h.session.onDelta("Talking now. ");
    await wait(20);
    h.setBusy(true);
    h.session.interrupt();
    expect(h.eventsOf("voice:stop-audio")).toHaveLength(1);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.session.currentState).toBe("listening");
  });

  it("does not abort when nothing is running", async () => {
    const h = harness();
    h.session.start();
    h.session.interrupt();
    expect(h.abort).not.toHaveBeenCalled();
  });

  it("logs and drops a transcript produced by a weak/short echo onset instead of posting it", async () => {
    const h = harness({ transcript: "her own words coming back" });
    h.session.start();
    h.session.onStreamStart();
    h.session.onDelta("A long answer that keeps going. ");
    await wait(30);

    // Quiet, sustained playback leakage: never crosses the barge-in bar.
    h.session.pushAudio(concat(silence(60), tone(400, 1200), silence(800)));
    await wait(20);

    expect(h.eventsOf("voice:stop-audio")).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.activity.some((a) => a.includes("ignored echo onset"))).toBe(true);
    expect(h.activity.some((a) => a.includes("dropped echo transcript"))).toBe(true);
  });

  it("logs a barge-in confirmation once the sustained window passes", async () => {
    const h = harness();
    h.session.start();
    h.session.onStreamStart();
    h.session.onDelta("Talking for a while now. ");
    await wait(20);
    h.session.pushAudio(concat(silence(60), tone(320)));
    expect(h.activity.some((a) => a.includes("barge-in confirmed"))).toBe(true);
    expect(h.session.getEvents().some((e) => e.type === "barge-in")).toBe(true);
  });

  it("sends the bare transcript when nothing had been spoken yet", async () => {
    const h = harness({ transcript: "second question" });
    h.session.start();
    h.session.onStreamStart(); // thinking, no deltas yet
    h.setBusy(true);
    await speak(h);
    expect(h.sent[0]).toBe("second question");
  });
});
