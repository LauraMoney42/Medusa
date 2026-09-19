/**
 * Live mode's turn-taking belongs to Gemini, and to nothing else.
 *
 * The owner reported two symptoms from one cause: Medusa and the Live API both
 * thought they were in charge of whose turn it was. She got talked over, and
 * after one round trip her mic stopped reaching the model at all. These tests
 * pin the split down from three sides:
 *
 *  1. the local pipeline's `Vad` / `BargeInDetector` are never reached from a
 *     live session, by import and by construction;
 *  2. mic frames keep flowing through a whole turn cycle (user, assistant,
 *     user), including while the assistant speaks, because that continuous
 *     stream is the only thing Gemini's own VAD has to find the next turn in;
 *  3. `serverContent.interrupted` becomes `voice:stop-audio` directly, with no
 *     Medusa-side gate in between.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LiveVoiceSession } from "../live-session.js";
import { GeminiLiveProvider } from "../gemini-live.js";
import type { MinimalWebSocket } from "../../streaming-stt.js";
import type {
  RealtimeHandlers,
  RealtimeOpenOptions,
  RealtimeVoiceProvider,
} from "../../realtime.js";
import type { ShimEnv } from "../../../mcp/client.js";

const here = dirname(fileURLToPath(import.meta.url));

const shim: ShimEnv = {
  url: "http://127.0.0.1:9999",
  token: "t",
  parentSessionId: "s1",
  toolsets: null,
};

/**
 * A provider that records every frame pushed at it, so a test can ask the one
 * question that matters for bug 2: did the mic keep reaching the model?
 */
function recordingHarness() {
  let handlers: RealtimeHandlers = {};
  const pushed: Int16Array[] = [];
  const interrupts = { count: 0 };

  const provider: RealtimeVoiceProvider = {
    id: "fake-live",
    displayName: "Fake Live",
    isReady: () => true,
    open: (opts: RealtimeOpenOptions) => {
      handlers = opts;
      return {
        pushAudio: (pcm: Int16Array) => pushed.push(pcm),
        commit: () => undefined,
        interrupt: () => {
          interrupts.count += 1;
          handlers.onInterrupt?.();
        },
        close: () => undefined,
      } as never;
    },
  };

  const emitted: Array<{ event: string; payload: any }> = [];
  const live = new LiveVoiceSession({
    sessionId: "s1",
    provider,
    shim,
    emit: (event, payload) => emitted.push({ event, payload }),
    activity: () => undefined,
    chatStore: { appendMessage: () => undefined },
    session: { workingDir: "/tmp/project" },
    onFatal: () => undefined,
  });
  live.start();

  return {
    live,
    pushed,
    interrupts,
    emitted,
    get handlers() {
      return handlers;
    },
    of: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
  };
}

/** One 100 ms frame of 16 kHz PCM16 at a given amplitude. */
function micFrame(amplitude: number): Buffer {
  const samples = 1_600;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(amplitude, i * 2);
  return buf;
}

function silence(samples: number): string {
  return Buffer.alloc(samples * 2).toString("base64");
}

describe("live mode does not run the local pipeline's turn-taking", () => {
  it("declares that it owns no turn-taking of its own", () => {
    expect(LiveVoiceSession.usesLocalTurnTaking).toBe(false);
  });

  it("imports neither the VAD nor the barge-in detector", () => {
    for (const file of ["live-session.ts", "gemini-live.ts"]) {
      const src = readFileSync(resolve(here, "..", file), "utf-8");
      const imports = src
        .split("\n")
        .filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line));
      expect(imports.join("\n")).not.toMatch(/barge-in/);
      expect(imports.join("\n")).not.toMatch(/\bvad\.js\b/);
    }
  });

  it("never constructs a Vad or a BargeInDetector across a whole conversation", async () => {
    // Any use of either module from the live path would throw here, which is a
    // stronger promise than the import check alone: a lazy `await import` would
    // trip it too.
    vi.resetModules();
    vi.doMock("../../vad.js", () => ({
      Vad: class {
        constructor() {
          throw new Error("live mode must not build a Vad");
        }
      },
      VAD_DEFAULTS: {},
    }));
    vi.doMock("../../barge-in.js", () => ({
      BargeInDetector: class {
        constructor() {
          throw new Error("live mode must not build a BargeInDetector");
        }
      },
      BARGE_IN_DEFAULTS: {},
    }));
    try {
      const mod = await import("../live-session.js");
      const emitted: string[] = [];
      let handlers: RealtimeHandlers = {};
      const session = new mod.LiveVoiceSession({
        sessionId: "s1",
        provider: {
          id: "fake",
          displayName: "fake",
          isReady: () => true,
          open: (opts: RealtimeOpenOptions) => {
            handlers = opts;
            return {
              pushAudio: () => undefined,
              commit: () => undefined,
              interrupt: () => undefined,
              close: () => undefined,
            } as never;
          },
        } as RealtimeVoiceProvider,
        shim,
        emit: (event) => emitted.push(event),
        activity: () => undefined,
        chatStore: { appendMessage: () => undefined },
        session: { workingDir: "/tmp/project" },
        onFatal: () => undefined,
      });
      session.start();
      session.pushAudio(micFrame(6_000));
      handlers.onUserTranscript?.("hello");
      handlers.onState?.("speaking");
      handlers.onAudio?.({ seq: 0, mime: "audio/pcm;rate=24000", data: silence(4_800) });
      handlers.onState?.("listening");
      session.pushAudio(micFrame(6_000));
      session.dispose();
      expect(emitted).toContain("voice:audio-chunk");
    } finally {
      vi.doUnmock("../../vad.js");
      vi.doUnmock("../../barge-in.js");
      vi.resetModules();
    }
  });
});

describe("mic frames across a full live turn cycle", () => {
  it("forwards every frame while the user speaks, while she speaks, and on the user's next turn", () => {
    const h = recordingHarness();

    // 1. The user's first turn.
    for (let i = 0; i < 5; i++) h.live.pushAudio(micFrame(6_000));
    h.handlers.onUserTranscript?.("what is in this folder");
    expect(h.pushed).toHaveLength(5);

    // 2. Her reply. The mic keeps streaming straight through it, which is what
    // lets Gemini's VAD hear a barge-in and, crucially, hear the user's next
    // turn begin at all.
    h.handlers.onState?.("speaking");
    h.handlers.onAudio?.({ seq: 0, mime: "audio/pcm;rate=24000", data: silence(4_800) });
    for (let i = 0; i < 5; i++) h.live.pushAudio(micFrame(200));
    expect(h.pushed).toHaveLength(10);
    h.handlers.onState?.("listening");

    // 3. The user's SECOND turn: the one that used to go nowhere.
    for (let i = 0; i < 5; i++) h.live.pushAudio(micFrame(6_000));
    expect(h.pushed).toHaveLength(15);
    // Every frame arrived whole: nothing was dropped, ducked to zero, or held.
    expect(h.pushed.every((f) => f.length === 1_600)).toBe(true);

    h.handlers.onUserTranscript?.("and the second one?");
    h.handlers.onState?.("speaking");
    h.handlers.onAudio?.({ seq: 0, mime: "audio/pcm;rate=24000", data: silence(4_800) });

    // She answers the second turn: two spoken turns, two sets of audio.
    expect(h.of("voice:speaking-start")).toHaveLength(2);
    expect(h.of("voice:audio-chunk")).toHaveLength(2);
    // And Medusa raised no interruption of its own anywhere in the cycle.
    expect(h.interrupts.count).toBe(0);
  });

  it("keeps forwarding frames after an interruption, with no gate to reopen", () => {
    const h = recordingHarness();
    h.handlers.onState?.("speaking");
    h.handlers.onAudio?.({ seq: 0, mime: "audio/pcm;rate=24000", data: silence(4_800) });
    // Gemini's own VAD reports the barge-in.
    h.handlers.onInterrupt?.();
    for (let i = 0; i < 4; i++) h.live.pushAudio(micFrame(6_000));
    expect(h.pushed).toHaveLength(4);
  });
});

// ---- The provider's own interruption signal -----------------------------

/** A socket whose frames the test feeds by hand. */
function fakeSocket() {
  const listeners = new Map<string, Array<(ev: any) => void>>();
  const sent: string[] = [];
  const socket: MinimalWebSocket = {
    addEventListener: (type: string, fn: (ev: any) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    send: (data: string) => sent.push(data),
    close: () => undefined,
  } as unknown as MinimalWebSocket;
  return {
    socket,
    sent,
    fire: (type: string, ev: unknown) => {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    },
    frame: (payload: unknown) => {
      for (const fn of listeners.get("message") ?? []) fn({ data: JSON.stringify(payload) });
    },
  };
}

describe("serverContent.interrupted maps straight to voice:stop-audio", () => {
  it("emits stop-audio for the interrupted turn and nothing else in the way", () => {
    const io = fakeSocket();
    const provider = new GeminiLiveProvider({
      apiKey: "k",
      createSocket: () => io.socket,
    });

    const emitted: Array<{ event: string; payload: any }> = [];
    const live = new LiveVoiceSession({
      sessionId: "s1",
      provider,
      shim,
      emit: (event, payload) => emitted.push({ event, payload }),
      activity: () => undefined,
      chatStore: { appendMessage: () => undefined },
      session: { workingDir: "/tmp/project" },
      onFatal: () => undefined,
    });
    live.start();
    io.fire("open", {});
    io.frame({ setupComplete: {} });

    // She starts talking.
    io.frame({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: silence(4_800) } }],
        },
      },
    });
    const turnId = emitted.find((e) => e.event === "voice:speaking-start")!.payload.turnId;
    expect(turnId).toBeTruthy();

    // The user talks over her, and Gemini says so.
    io.frame({ serverContent: { interrupted: true } });

    const stops = emitted.filter((e) => e.event === "voice:stop-audio");
    expect(stops).toHaveLength(1);
    expect(stops[0].payload.turnId).toBe(turnId);
    expect(emitted.filter((e) => e.event === "voice:speaking-end").at(-1)!.payload.turnId).toBe(
      turnId
    );
    expect(emitted.filter((e) => e.event === "voice:state").at(-1)!.payload.state).toBe(
      "listening"
    );

    // Nothing was sent back up the socket for it: the interruption is the
    // service's own, and there is no cancel message to answer it with.
    expect(io.sent.slice(1)).toEqual([]);

    // And her next turn plays immediately, under a new id.
    io.frame({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: silence(4_800) } }],
        },
      },
    });
    const chunks = emitted.filter((e) => e.event === "voice:audio-chunk");
    expect(chunks).toHaveLength(2);
    expect(chunks[1].payload.turnId).not.toBe(turnId);
    expect(chunks[1].payload.seq).toBe(0);
  });
});
