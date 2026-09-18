/**
 * The hybrid half of Live mode: tier selection, and the translation from a
 * realtime provider's events into the Section 7 contract the client already
 * speaks.
 *
 * The provider here is a hand-driven fake rather than Gemini, because what is
 * under test is the wiring: a chat must end up on some tier no matter what is
 * configured, audio must reach the client in a form its scheduler can decode,
 * both sides of the conversation must land in the chat, and a barge-in must
 * stop playback immediately.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REALTIME_CANDIDATES,
  LIVE_CHUNK_SAMPLES,
  LiveVoiceSession,
  base64ToInt16,
  selectVoiceTier,
  tierFromSettings,
  toLoopState,
} from "../live-session.js";
import type {
  RealtimeHandlers,
  RealtimeOpenOptions,
  RealtimeVoiceProvider,
} from "../../realtime.js";
import type { ShimEnv } from "../../../mcp/client.js";

const shim: ShimEnv = {
  url: "http://127.0.0.1:9999",
  token: "t",
  parentSessionId: "s1",
  toolsets: null,
};

function stubProvider(id: string, ready: boolean, model = "m-1"): RealtimeVoiceProvider {
  return {
    id,
    displayName: id,
    model,
    isReady: () => ready,
    open: () => ({
      pushAudio: () => undefined,
      commit: () => undefined,
      interrupt: () => undefined,
      close: () => undefined,
    }),
  } as RealtimeVoiceProvider;
}

describe("selectVoiceTier", () => {
  it("takes Live when a realtime key exists", () => {
    const decision = selectVoiceTier({
      preference: "auto",
      resolve: (id) => (id === "gemini-live" ? stubProvider("gemini-live", true) : null),
    });
    expect(decision.tier).toBe("live");
    expect(decision.providerId).toBe("gemini-live");
    expect(decision.model).toBe("m-1");
  });

  it("falls back to the local pipeline with the free-key hint when no key exists", () => {
    const decision = selectVoiceTier({ preference: "auto", resolve: () => null });
    expect(decision.tier).toBe("pipeline");
    expect(decision.reason).toContain("aistudio.google.com/apikey");
  });

  it("honours a pinned pipeline even when Live is available", () => {
    const decision = selectVoiceTier({
      preference: "pipeline",
      resolve: () => stubProvider("gemini-live", true),
    });
    expect(decision.tier).toBe("pipeline");
  });

  it("still falls back when Live is preferred but keyless, because voice always works", () => {
    const decision = selectVoiceTier({ preference: "live", resolve: () => null });
    expect(decision.tier).toBe("pipeline");
  });

  it("prefers the provider named in settings, then the default order", () => {
    const decision = selectVoiceTier({
      preference: "auto",
      providerId: "openai-realtime",
      resolve: (id) => stubProvider(id, true),
    });
    expect(decision.providerId).toBe("openai-realtime");
    expect(DEFAULT_REALTIME_CANDIDATES[0]).toBe("gemini-live");
  });

  it("reads the preference and model straight off the voice pack", () => {
    const seen: Array<string | undefined> = [];
    const decision = tierFromSettings(
      { liveTier: "auto", liveProvider: "gemini-live", liveModel: "custom-model" },
      (id, model) => {
        seen.push(model);
        return stubProvider(id, true, model ?? "default");
      }
    );
    expect(seen).toContain("custom-model");
    expect(decision.model).toBe("custom-model");
  });
});

describe("toLoopState", () => {
  it("never reports idle while the socket is still coming up", () => {
    expect(toLoopState("connecting")).toBe("thinking");
    expect(toLoopState("listening")).toBe("listening");
    expect(toLoopState("speaking")).toBe("speaking");
    expect(toLoopState("closed")).toBe("idle");
  });
});

// ---- The session --------------------------------------------------------

/** A provider whose handlers the test fires by hand. */
function harness() {
  let handlers: RealtimeHandlers = {};
  let opened: RealtimeOpenOptions | null = null;
  const closed = { count: 0 };
  const injected: string[] = [];

  const provider: RealtimeVoiceProvider = {
    id: "fake-live",
    displayName: "Fake Live",
    isReady: () => true,
    open: (opts: RealtimeOpenOptions) => {
      opened = opts;
      handlers = opts;
      return {
        pushAudio: () => undefined,
        commit: () => undefined,
        interrupt: () => handlers.onInterrupt?.(),
        injectTurn: (text: string) => injected.push(text),
        close: () => {
          closed.count += 1;
        },
      } as any;
    },
  };

  const emitted: Array<{ event: string; payload: any }> = [];
  const appended: any[] = [];
  const fatal: Error[] = [];
  let clock = 1_000;

  const live = new LiveVoiceSession({
    sessionId: "s1",
    provider,
    shim,
    emit: (event, payload) => emitted.push({ event, payload }),
    activity: () => undefined,
    chatStore: { appendMessage: (m: any) => appended.push(m) },
    session: { workingDir: "/tmp/project", systemPrompt: "Project note." },
    onFatal: (err) => fatal.push(err),
    now: () => (clock += 10),
  });
  live.start();

  return {
    live,
    emitted,
    appended,
    fatal,
    injected,
    closed,
    get handlers() {
      return handlers;
    },
    get opened() {
      return opened!;
    },
    of: (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload),
  };
}

/** Base64 for `samples` PCM16 zero samples, the shape Gemini returns. */
function silence(samples: number): string {
  return Buffer.alloc(samples * 2).toString("base64");
}

describe("LiveVoiceSession", () => {
  it("gives the realtime model Medusa's own persona, folder and tools", () => {
    const h = harness();
    expect(h.opened.instructions).toContain("/tmp/project");
    expect(h.opened.instructions).toContain("Project note.");
    // Voice mode: the spoken-style section has to be in there.
    expect(h.opened.instructions).toContain("read out loud");
    // Bare tool names, not the claude CLI's mcp__medusa__ spelling.
    expect(h.opened.instructions).toContain("`spawn_agent`");
    expect(h.opened.instructions).not.toContain("mcp__medusa__spawn_agent");
    expect(h.opened.toolSpecs?.map((s) => s.name)).toContain("spawn_agent");
    expect(h.opened.tools.parentSessionId).toBe("s1");
  });

  it("emits the same voice:state names the pipeline emits", () => {
    const h = harness();
    h.handlers.onState?.("listening");
    h.handlers.onState?.("speaking");
    expect(h.of("voice:state").map((p) => p.state)).toEqual(["listening", "speaking"]);
    expect(h.of("voice:speaking-start")).toHaveLength(1);
  });

  it("forwards input transcription as voice:partial", () => {
    const h = harness();
    h.handlers.onUserPartial?.("what's in");
    expect(h.of("voice:partial")[0]).toEqual({ sessionId: "s1", text: "what's in" });
  });

  it("posts the user's words into the chat tagged voice-live", () => {
    const h = harness();
    h.handlers.onUserTranscript?.("what's in this folder");

    const msg = h.of("message:user")[0];
    expect(msg.role).toBe("user");
    expect(msg.text).toBe("what's in this folder");
    expect(msg.source).toBe("voice-live");
    expect(h.of("voice:transcript")[0].messageId).toBe(msg.id);
    expect(h.appended).toContainEqual(expect.objectContaining({ role: "user", source: "voice-live" }));
  });

  it("streams her reply as an ordinary assistant message", () => {
    const h = harness();
    h.handlers.onUserTranscript?.("hi");
    h.handlers.onAssistantDelta?.("Six files");
    h.handlers.onAssistantDelta?.(", mostly TypeScript.");
    h.handlers.onAssistantTranscript?.("Six files, mostly TypeScript.");

    const start = h.of("message:stream:start")[0];
    expect(start.role).toBe("assistant");
    expect(h.of("message:stream:delta").map((d) => d.delta)).toEqual([
      "Six files",
      ", mostly TypeScript.",
    ]);
    expect(h.of("message:stream:end")[0].messageId).toBe(start.id);
    expect(h.appended).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "Six files, mostly TypeScript." })
    );
  });

  it("recovers a turn that only produced a final transcript", () => {
    const h = harness();
    h.handlers.onAssistantTranscript?.("All done.");
    expect(h.of("message:stream:delta")[0].delta).toBe("All done.");
    expect(h.of("message:stream:end")).toHaveLength(1);
  });

  it("buffers 24 kHz PCM into WAV chunks the client scheduler can decode", () => {
    const h = harness();
    // Half a chunk: nothing goes out yet.
    h.handlers.onAudio?.({ seq: 0, mime: "audio/pcm;rate=24000", data: silence(LIVE_CHUNK_SAMPLES / 2) });
    expect(h.of("voice:audio-chunk")).toHaveLength(0);

    h.handlers.onAudio?.({ seq: 1, mime: "audio/pcm;rate=24000", data: silence(LIVE_CHUNK_SAMPLES) });
    const chunks = h.of("voice:audio-chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].seq).toBe(0);
    expect(chunks[0].mime).toBe("audio/wav");

    const wav = Buffer.from(chunks[0].data, "base64");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    // The sample rate in the header has to say 24 kHz or she plays back slow.
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.length).toBe(44 + LIVE_CHUNK_SAMPLES * 2);
  });

  it("numbers chunks in order", () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.handlers.onAudio?.({ seq: i, mime: "audio/pcm;rate=24000", data: silence(LIVE_CHUNK_SAMPLES) });
    }
    expect(h.of("voice:audio-chunk").map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  it("stops audio immediately on the provider's interruption signal", () => {
    const h = harness();
    h.handlers.onState?.("speaking");
    h.handlers.onAudio?.({ seq: 0, mime: "audio/pcm;rate=24000", data: silence(LIVE_CHUNK_SAMPLES) });
    h.handlers.onAssistantDelta?.("Six files, mostly");

    h.handlers.onInterrupt?.();

    expect(h.of("voice:stop-audio")).toHaveLength(1);
    expect(h.of("voice:speaking-end")).toHaveLength(1);
    // What she managed to say is still what the chat shows.
    expect(h.appended.at(-1)).toEqual(
      expect.objectContaining({ role: "assistant", text: "Six files, mostly" })
    );
    // Seq restarts so the client scheduler accepts the next turn.
    h.handlers.onAudio?.({ seq: 0, mime: "audio/pcm;rate=24000", data: silence(LIVE_CHUNK_SAMPLES) });
    expect(h.of("voice:audio-chunk").at(-1).seq).toBe(0);
  });

  it("reports latency from the end of the user's turn to her first audio", () => {
    const h = harness();
    h.handlers.onUserTranscript?.("hi");
    h.handlers.onAudio?.({ seq: 0, mime: "audio/pcm;rate=24000", data: silence(LIVE_CHUNK_SAMPLES) });
    h.handlers.onAssistantTranscript?.("Hello.");

    const latency = h.of("voice:latency")[0];
    expect(latency.live).toBe(true);
    expect(latency.firstAudioMs).toBeGreaterThan(0);
    expect(latency.totalMs).toBeGreaterThanOrEqual(latency.firstAudioMs);
  });

  it("speaks a subagent follow-up instead of letting it land as text only", () => {
    const h = harness();
    h.live.injectFollowup("[Agent counter done] 412 files.");
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toContain("412 files");
    // Framed so the persona knows the user did not say it.
    expect(h.injected[0]).toContain("[System]");
  });

  it("hands a provider error to the caller once, for the fallback", () => {
    const h = harness();
    h.handlers.onError?.(new Error("quota exceeded"));
    h.handlers.onError?.(new Error("and again"));
    expect(h.fatal).toHaveLength(1);
    expect(h.fatal[0].message).toBe("quota exceeded");
  });

  it("flushes buffered audio and closes the socket on dispose", () => {
    const h = harness();
    h.handlers.onAudio?.({ seq: 0, mime: "audio/pcm;rate=24000", data: silence(100) });
    h.live.dispose();
    expect(h.of("voice:audio-chunk")).toHaveLength(1);
    expect(h.closed.count).toBe(1);
    h.live.dispose();
    expect(h.closed.count).toBe(1);
  });
});

describe("base64ToInt16", () => {
  it("round-trips little-endian PCM16", () => {
    const buf = Buffer.alloc(6);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(-1, 2);
    buf.writeInt16LE(32767, 4);
    expect([...base64ToInt16(buf.toString("base64"))]).toEqual([0, -1, 32767]);
  });
});
