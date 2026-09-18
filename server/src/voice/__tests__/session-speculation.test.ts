/**
 * S16 item 3, end to end through `VoiceSession`: a stable partial starts the
 * engine turn early, and the real transcript either keeps that turn or throws
 * it away and starts again.
 */

import { describe, expect, it, vi } from "vitest";
import { VoiceSession } from "../session.js";
import type { SttProvider, TtsProvider } from "../providers.js";
import type { SttStreamHandlers, StreamingSttProvider } from "../streaming-stt.js";

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

/** A partial provider the test drives by hand. */
function manualPartials() {
  let handlers: SttStreamHandlers | null = null;
  const provider: StreamingSttProvider = {
    id: "manual",
    supportsPartials: true,
    isReady: () => true,
    open(h) {
      handlers = h;
      return { push: () => {}, end: () => {}, close: () => { handlers = null; } };
    },
  };
  return { provider, emit: (text: string) => handlers?.onPartial?.(text) };
}

function build(finalText: string, speculationEnabled = true) {
  const { provider, emit } = manualPartials();
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const sent: string[] = [];
  const activity: string[] = [];
  const abortTurn = vi.fn();
  let busy = false;

  const stt: SttProvider = {
    id: "fake",
    supportsPartials: false,
    isReady: () => true,
    transcribe: async () => finalText,
  };
  const tts: TtsProvider = {
    id: "fake",
    isReady: () => true,
    synthesize: async (text: string) => ({ audio: Buffer.from(text), mime: "audio/wav" }),
  };

  const session = new VoiceSession({
    sessionId: "s1",
    emit: (event, payload) => events.push({ event, payload }),
    activity: (summary) => activity.push(summary),
    send: (text) => {
      sent.push(text);
      busy = true;
    },
    abortTurn: () => {
      busy = false;
      abortTurn();
    },
    isBusy: () => busy,
    stt,
    tts,
    partials: provider,
    // Short windows so the test does not have to sleep for the real 400 ms.
    speculation: { stableMs: 5, pauseMs: 5, enabled: speculationEnabled },
  });

  return { session, emit, events, sent, activity, abortTurn, endTurn: () => (busy = false) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("VoiceSession speculative start", () => {
  it("emits voice:partial and starts the turn before the user stops talking", async () => {
    const { session, emit, events, sent } = build("what files are here");
    session.start();
    session.pushAudio(tone(200));
    emit("what files are here?");
    await wait(15);
    session.pushAudio(tone(100));

    expect(events.some((e) => e.event === "voice:partial")).toBe(true);
    expect(sent).toEqual(["what files are here?"]);
    expect(session.currentState).toBe("thinking");
    expect(session.speculationStats.starts).toBe(1);
  });

  it("keeps the speculative turn when the transcript agrees", async () => {
    const { session, emit, sent, abortTurn, activity, endTurn } = build(
      "What files are here?"
    );
    session.start();
    session.pushAudio(tone(300));
    // No sentence punctuation, so a second identical partial is what confirms
    // the pause.
    emit("what files are here");
    emit("what files are here");
    await wait(15);
    session.pushAudio(tone(100));
    expect(sent).toHaveLength(1);

    endTurn();
    session.pushAudio(silence(800));
    await wait(20);

    expect(sent).toHaveLength(1); // no restart
    expect(abortTurn).not.toHaveBeenCalled();
    expect(activity.some((a) => a.includes("speculation held"))).toBe(true);
    expect(session.speculationStats.aborts).toBe(0);
  });

  it("aborts and restarts when the transcript says something else", async () => {
    const { session, emit, sent, abortTurn, activity } = build(
      "cancel that and read the readme instead"
    );
    session.start();
    session.pushAudio(tone(300));
    emit("what time is it?");
    await wait(15);
    session.pushAudio(tone(100));
    expect(sent).toEqual(["what time is it?"]);

    session.pushAudio(silence(800));
    await wait(20);

    expect(abortTurn).toHaveBeenCalledOnce();
    expect(sent).toEqual(["what time is it?", "cancel that and read the readme instead"]);
    expect(activity.some((a) => a.includes("speculation discarded"))).toBe(true);
    expect(session.speculationStats.aborts).toBe(1);
  });

  it("does not let the abandoned turn speak or report its latency", async () => {
    const { session, emit, events } = build("read the readme instead");
    session.start();
    session.pushAudio(tone(300));
    emit("what time is it?");
    await wait(15);
    session.pushAudio(tone(100));

    // The abandoned turn started streaming (with its own real message id)
    // before it was replaced.
    session.onStreamStart("turn-a");
    session.pushAudio(silence(800));
    await wait(20);
    // Its tail arrives after the restart, still tagged with the OLD id, and
    // must be ignored entirely: the id is recorded as abandoned the instant
    // the restart aborts it, so this is rejected even though the replacement
    // turn (started by the restart above) has not reached its own
    // `message:stream:start` yet and so has no id of its own to compare
    // against.
    session.onDelta("It is about four o'clock. ", "turn-a");
    session.onStreamEnd("turn-a");
    await wait(20);

    expect(events.some((e) => e.event === "voice:audio-chunk")).toBe(false);
    expect(events.some((e) => e.event === "voice:latency")).toBe(false);
  });

  it("ignores the abandoned turn's settle event instead of killing the restart", async () => {
    const { session, emit, events, sent } = build("read the readme instead");
    session.start();
    session.pushAudio(tone(300));
    emit("what time is it?");
    await wait(15);
    session.pushAudio(tone(100));
    expect(sent).toEqual(["what time is it?"]);

    // The real transcript replaces the guess, which aborts the first turn.
    session.pushAudio(silence(800));
    await wait(20);
    expect(sent).toHaveLength(2);

    // The abort settles the abandoned turn (its own real id, "turn-a").
    // Against the warm Kimi engine that is a `message:stream:end`, and it can
    // land AFTER the restarted turn's own stream start, so `streamStarted`
    // alone cannot tell them apart; matching ids (and rejecting a known-
    // abandoned one) must not close the restarted turn's ("turn-b") TTS.
    session.onStreamStart("turn-b");
    session.onStreamEnd("turn-a");
    session.onDelta("The readme says hello. ", "turn-b");
    session.onStreamEnd("turn-b");
    await wait(30);

    expect(events.some((e) => e.event === "voice:audio-chunk")).toBe(true);
    expect(session.currentState).not.toBe("idle");
  });

  // Merge invariant between the S14 echo fix and S16's speculative start: the
  // barge-in detector's armed window (thinking, speaking, and the grace period
  // after) is exactly when the mic is hearing her own reply, so nothing in that
  // window may become a partial or start a turn.
  it("never speculates on a partial heard while she is the one talking", async () => {
    const { session, emit, events, sent } = build("what files are here");
    session.start();
    // A reply is streaming: the barge-in detector is armed, so every partial
    // from here on is presumed to be her own audio leaking back in.
    session.onStreamStart();
    session.pushAudio(tone(200));
    emit("what files are here?");
    await wait(15);
    session.pushAudio(tone(100));

    expect(events.some((e) => e.event === "voice:partial")).toBe(false);
    expect(sent).toEqual([]);
    expect(session.speculationStats.starts).toBe(0);
  });

  it("stays on the transcript when speculation is switched off", async () => {
    const { session, emit, sent } = build("what files are here", false);
    session.start();
    session.pushAudio(tone(300));
    emit("what files are here?");
    await wait(15);
    session.pushAudio(tone(100));
    expect(sent).toEqual([]);

    session.pushAudio(silence(800));
    await wait(20);
    expect(sent).toEqual(["what files are here"]);
  });
});
