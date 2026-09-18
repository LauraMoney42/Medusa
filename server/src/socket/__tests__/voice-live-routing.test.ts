/**
 * Tier selection and routing at the socket layer (S17).
 *
 * The product rule these pin down: voice always works, Medusa picks the best
 * tier she can reach, and she says which one the user got. A key means Live;
 * no key means the local pipeline; a Live failure mid-session demotes the chat
 * rather than leaving the microphone dead, and Live is tried again on the next
 * `voice:start`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Server as IOServer, Socket } from "socket.io";
import type { SessionStore, SessionMeta } from "../../sessions/store.js";
import type { ProcessManager } from "../../claude/process-manager.js";
import type { RealtimeHandlers, RealtimeVoiceProvider } from "../../voice/realtime.js";

/** Swapped per test: what `getRealtimeProvider` hands back. */
const realtime: {
  provider: RealtimeVoiceProvider | null;
  handlers: RealtimeHandlers;
  injected: string[];
  closes: number;
  audioFrames: number;
} = { provider: null, handlers: {}, injected: [], closes: 0, audioFrames: 0 };

/** Swapped per test: what the voice pack says. */
let voiceSettings: Record<string, unknown> = {};

vi.mock("../../voice/providers.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getRealtimeProvider: () => realtime.provider,
  };
});

vi.mock("../../packs/store.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, readVoice: () => voiceSettings };
});

const { registerVoiceHandlers, getLiveSession, listVoiceSessions, resetVoiceSessions } =
  await import("../voice-handlers.js");
const { setVoiceProviders } = await import("../../voice/providers.js");

function liveProvider(): RealtimeVoiceProvider {
  return {
    id: "gemini-live",
    displayName: "Gemini Live (native audio)",
    model: "gemini-2.5-flash-native-audio-latest",
    isReady: () => true,
    open: (opts: RealtimeHandlers) => {
      realtime.handlers = opts;
      return {
        pushAudio: () => {
          realtime.audioFrames += 1;
        },
        commit: () => undefined,
        interrupt: () => undefined,
        injectTurn: (text: string) => realtime.injected.push(text),
        close: () => {
          realtime.closes += 1;
        },
      } as never;
    },
  } as unknown as RealtimeVoiceProvider;
}

function fakeIo() {
  const wire: { event: string; payload: Record<string, unknown>; room: string }[] = [];
  const adapter = {
    broadcast(packet: { type: number; data?: unknown[] }, opts: { rooms?: Set<string> }) {
      const [event, payload] = (packet.data ?? []) as [string, Record<string, unknown>];
      for (const room of opts.rooms ?? []) wire.push({ event, payload, room });
    },
  };
  const io = {
    sockets: { adapter },
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) => {
        adapter.broadcast({ type: 2, data: [event, payload] }, { rooms: new Set([room]) });
        return true;
      },
    }),
  };
  return { io: io as unknown as IOServer, wire };
}

function fakeSocket() {
  const listeners = new Map<string, (payload: never) => void>();
  const socket = {
    on(event: string, listener: (payload: never) => void) {
      listeners.set(event, listener);
      return socket;
    },
    join: () => undefined,
    emit: vi.fn(),
  };
  return {
    socket: socket as unknown as Socket,
    fire: (event: string, payload: unknown) => listeners.get(event)?.(payload as never),
  };
}

function fakeStore(): SessionStore {
  const session = {
    id: "s1",
    name: "chat",
    workingDir: "/tmp/project",
    createdAt: "",
    lastActiveAt: "",
  } as SessionMeta;
  return {
    get: (id: string) => (id === "s1" ? session : undefined),
    overrideModelForTurn: () => () => undefined,
  } as unknown as SessionStore;
}

function fakeProcessManager(): ProcessManager {
  return {
    isSessionBusy: () => false,
    abort: vi.fn(),
    setWarmMode: vi.fn(() => "kimi-warm"),
    isWarmMode: () => true,
  } as unknown as ProcessManager;
}

function start() {
  const { io, wire } = fakeIo();
  const { socket, fire } = fakeSocket();
  const appended: unknown[] = [];
  registerVoiceHandlers(io, socket, {
    store: fakeStore(),
    processManager: fakeProcessManager(),
    chatStore: { appendMessage: (m) => appended.push(m) },
    sendMessage: async () => undefined,
  });
  return {
    io,
    wire,
    appended,
    fire,
    of: (event: string) => wire.filter((w) => w.event === event).map((w) => w.payload),
  };
}

beforeEach(() => {
  resetVoiceSessions();
  realtime.provider = null;
  realtime.handlers = {};
  realtime.injected = [];
  realtime.closes = 0;
  realtime.audioFrames = 0;
  voiceSettings = { liveTier: "auto", liveProvider: "gemini-live", liveModel: "", warmEngine: true };
  setVoiceProviders({
    stt: {
      id: "fake-stt",
      supportsPartials: false,
      isReady: () => true,
      transcribe: async () => "hello",
    },
    tts: {
      id: "fake-tts",
      isReady: () => true,
      synthesize: async (text: string) => ({ audio: Buffer.from(text), mime: "audio/wav" }),
    },
  });
});

afterEach(() => {
  resetVoiceSessions();
  setVoiceProviders({ stt: null, tts: null });
});

describe("tier selection on voice:start", () => {
  it("announces the pipeline tier, with the free-key hint, when no key exists", () => {
    const h = start();
    h.fire("voice:start", { sessionId: "s1", mode: "always-on" });

    const tier = h.of("voice:tier")[0];
    expect(tier.tier).toBe("pipeline");
    expect(String(tier.reason)).toContain("aistudio.google.com/apikey");
    expect(getLiveSession("s1")).toBeUndefined();
    expect(listVoiceSessions()).toEqual([
      expect.objectContaining({ sessionId: "s1", tier: "pipeline" }),
    ]);
  });

  it("takes the live tier when a realtime provider has a key", () => {
    realtime.provider = liveProvider();
    const h = start();
    h.fire("voice:start", { sessionId: "s1", mode: "always-on" });

    const tier = h.of("voice:tier")[0];
    expect(tier.tier).toBe("live");
    expect(tier.provider ?? tier.providerId).toBe("gemini-live");
    expect(tier.model).toBe("gemini-2.5-flash-native-audio-latest");
    expect(getLiveSession("s1")).toBeDefined();
    expect(listVoiceSessions()).toEqual([
      expect.objectContaining({ sessionId: "s1", tier: "live" }),
    ]);
  });

  it("stays on the pipeline when the user pinned it, key or no key", () => {
    realtime.provider = liveProvider();
    voiceSettings = { ...voiceSettings, liveTier: "pipeline" };
    const h = start();
    h.fire("voice:start", { sessionId: "s1", mode: "always-on" });
    expect(h.of("voice:tier")[0].tier).toBe("pipeline");
    expect(getLiveSession("s1")).toBeUndefined();
  });
});

describe("routing while live", () => {
  it("sends voice:audio frames to the realtime provider, not the pipeline", () => {
    realtime.provider = liveProvider();
    const h = start();
    h.fire("voice:start", { sessionId: "s1", mode: "always-on" });
    h.fire("voice:audio", { sessionId: "s1", pcm16: new Int16Array([1, 2, 3, 4]).buffer });
    expect(realtime.audioFrames).toBe(1);
  });

  it("posts both sides of the conversation into the chat", () => {
    realtime.provider = liveProvider();
    const h = start();
    h.fire("voice:start", { sessionId: "s1", mode: "always-on" });

    realtime.handlers.onUserTranscript?.("what's in this folder");
    realtime.handlers.onAssistantDelta?.("Six files.");
    realtime.handlers.onAssistantTranscript?.("Six files.");

    expect(h.of("message:user")[0]).toEqual(
      expect.objectContaining({ text: "what's in this folder", source: "voice-live" })
    );
    expect(h.of("message:stream:delta")[0].delta).toBe("Six files.");
    expect(h.appended).toHaveLength(2);
  });

  it("speaks a subagent follow-up seen on the wire, without touching followups.ts", () => {
    realtime.provider = liveProvider();
    const h = start();
    h.fire("voice:start", { sessionId: "s1", mode: "always-on" });

    // Exactly what `subagents/followups.ts` broadcasts when an agent ends.
    h.io.to("s1").emit("message:user", {
      sessionId: "s1",
      role: "user",
      text: "[Agent counter done] 412 files.",
      source: "agent-followup",
    });
    expect(realtime.injected).toHaveLength(1);
    expect(realtime.injected[0]).toContain("412 files");

    // A normal typed message is not injected.
    h.io.to("s1").emit("message:user", { sessionId: "s1", role: "user", text: "hi" });
    expect(realtime.injected).toHaveLength(1);
  });

  it("releases the realtime socket on voice:stop", () => {
    realtime.provider = liveProvider();
    const h = start();
    h.fire("voice:start", { sessionId: "s1", mode: "always-on" });
    h.fire("voice:stop", { sessionId: "s1" });
    expect(realtime.closes).toBe(1);
    expect(getLiveSession("s1")).toBeUndefined();
  });
});

describe("fallback", () => {
  it("demotes to the pipeline mid-session and says so, then retries live next time", async () => {
    realtime.provider = liveProvider();
    const h = start();
    h.fire("voice:start", { sessionId: "s1", mode: "always-on" });
    expect(h.of("voice:tier")[0].tier).toBe("live");

    realtime.handlers.onError?.(new Error("quota exceeded"));

    const tiers = h.of("voice:tier");
    expect(tiers[1].tier).toBe("pipeline");
    expect(String(tiers[1].reason)).toContain("quota exceeded");
    expect(getLiveSession("s1")).toBeUndefined();
    // Voice is not dead: the pipeline session took over.
    expect(listVoiceSessions()).toEqual([
      expect.objectContaining({ sessionId: "s1", tier: "pipeline" }),
    ]);
    // And one short local line is spoken so the change is audible.
    await vi.waitFor(() => expect(h.of("voice:audio-chunk")).toHaveLength(1));
    expect(Buffer.from(h.of("voice:audio-chunk")[0].data as string, "base64").toString()).toBe(
      "Switching to local voice."
    );

    // The demotion lasts this session only.
    h.fire("voice:start", { sessionId: "s1", mode: "always-on" });
    expect(h.of("voice:tier").at(-1)!.tier).toBe("pipeline");
    h.fire("voice:stop", { sessionId: "s1" });
    h.fire("voice:start", { sessionId: "s1", mode: "always-on" });
    expect(h.of("voice:tier").at(-1)!.tier).toBe("live");
  });
});
