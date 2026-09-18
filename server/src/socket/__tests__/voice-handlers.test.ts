import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Server as IOServer, Socket } from "socket.io";
import type { SessionStore, SessionMeta } from "../../sessions/store.js";
import type { ProcessManager } from "../../claude/process-manager.js";
import { setVoiceProviders } from "../../voice/providers.js";
import {
  registerVoiceHandlers,
  getVoiceSession,
  listVoiceSessions,
  resetVoiceSessions,
} from "../voice-handlers.js";

const SAMPLE_RATE = 16_000;
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function tone(ms: number): Int16Array {
  const n = Math.round((SAMPLE_RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE));
  return out;
}
function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
}

/**
 * A stand-in for the real server: `io.to(room).emit()` goes through the
 * namespace adapter's `broadcast`, exactly as socket.io does, so the tap under
 * test sees the same traffic it sees in production.
 */
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
        // socket.io encodes inside broadcast(), so the tap can still mutate.
        (io.sockets.adapter as typeof adapter).broadcast(
          { type: 2, data: [event, payload] },
          { rooms: new Set([room]) }
        );
        return true;
      },
    }),
  };
  return { io: io as unknown as IOServer, wire };
}

function fakeSocket() {
  const listeners = new Map<string, (payload: never) => void>();
  const joined: string[] = [];
  const socket = {
    on(event: string, listener: (payload: never) => void) {
      listeners.set(event, listener);
      return socket;
    },
    join(room: string) {
      joined.push(room);
    },
    emit: vi.fn(),
  };
  const fire = (event: string, payload: unknown) =>
    listeners.get(event)?.(payload as never);
  return { socket: socket as unknown as Socket, fire, joined, listeners };
}

/**
 * Only the handful of ProcessManager methods the voice layer touches.
 * `setWarmMode`/`isWarmMode` are the S16 warm-engine hooks: voice:start asks
 * for warm mode, voice:stop gives it back.
 */
function fakeProcessManager(
  over: Partial<{
    isSessionBusy: (id: string) => boolean;
    abort: (id: string) => void;
    setWarmMode: (id: string, warm: boolean) => string | null;
    isWarmMode: (id: string) => boolean;
  }> = {}
): ProcessManager {
  return {
    isSessionBusy: () => false,
    abort: vi.fn(),
    setWarmMode: vi.fn(() => "kimi-warm"),
    isWarmMode: () => true,
    ...over,
  } as unknown as ProcessManager;
}

function fakeStore(meta: Partial<SessionMeta> & { id: string }) {
  const session = {
    name: "chat",
    workingDir: "/tmp",
    createdAt: "",
    lastActiveAt: "",
    ...meta,
  } as SessionMeta;
  const overrides: string[] = [];
  const store = {
    get: (id: string) => (id === session.id ? session : undefined),
    overrideModelForTurn: (id: string, model: string) => {
      overrides.push(model);
      const previous = session.model;
      session.model = model;
      return () => {
        session.model = previous;
      };
    },
  };
  return { store: store as unknown as SessionStore, session, overrides };
}

beforeEach(() => {
  resetVoiceSessions();
  setVoiceProviders({
    stt: {
      id: "fake-stt",
      supportsPartials: false,
      isReady: () => true,
      transcribe: async () => "what files are in this folder",
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

describe("registerVoiceHandlers", () => {
  it("voice:start creates a session and reports its state", () => {
    const { io, wire } = fakeIo();
    const { socket, fire, joined } = fakeSocket();
    const { store } = fakeStore({ id: "s1" });
    registerVoiceHandlers(io, socket, {
      store,
      processManager: fakeProcessManager(),
      sendMessage: async () => undefined,
    });

    fire("voice:start", { sessionId: "s1", mode: "always-on" });
    expect(joined).toContain("s1");
    expect(getVoiceSession("s1")?.currentState).toBe("listening");
    expect(listVoiceSessions()).toEqual([
      { sessionId: "s1", state: "listening", mode: "always-on", tier: "pipeline" },
    ]);
    expect(wire.some((w) => w.event === "voice:state")).toBe(true);
  });

  it("rejects an unknown session", () => {
    const { io } = fakeIo();
    const { socket, fire } = fakeSocket();
    const { store } = fakeStore({ id: "s1" });
    registerVoiceHandlers(io, socket, {
      store,
      processManager: fakeProcessManager(),
      sendMessage: async () => undefined,
    });
    fire("voice:start", { sessionId: "nope" });
    expect(getVoiceSession("nope")).toBeUndefined();
    expect(socket.emit).toHaveBeenCalledWith("error", { message: "Session not found" });
  });

  it("runs the whole loop: audio in, transcript, send, spoken deltas out", async () => {
    const { io, wire } = fakeIo();
    const { socket, fire } = fakeSocket();
    const { store } = fakeStore({ id: "s1" });
    const sendMessage = vi.fn(async (sessionId: string, text: string) => {
      // Mimic the real send path's broadcasts.
      io.to(sessionId).emit("message:user", { id: "u1", sessionId, role: "user", text });
      io.to(sessionId).emit("message:stream:start", { id: "a1", sessionId });
      io.to(sessionId).emit("message:stream:delta", {
        sessionId,
        messageId: "a1",
        delta: "There are three files. ",
      });
      io.to(sessionId).emit("message:stream:end", { sessionId, messageId: "a1" });
    });

    registerVoiceHandlers(io, socket, {
      store,
      processManager: fakeProcessManager({ isSessionBusy: () => false }),
      sendMessage,
    });

    fire("voice:start", { sessionId: "s1" });
    const pcm = new Int16Array(tone(400).length + silence(800).length);
    pcm.set(tone(400), 0);
    fire("voice:audio", { sessionId: "s1", pcm16: pcm });
    await wait(40);

    expect(sendMessage).toHaveBeenCalledWith("s1", "what files are in this folder");
    // The echoed user message is tagged as speech by the tap.
    const userMsg = wire.find((w) => w.event === "message:user");
    expect(userMsg?.payload.source).toBe("voice");
    // The delta was spoken.
    const chunks = wire.filter((w) => w.event === "voice:audio-chunk");
    expect(chunks).toHaveLength(1);
    expect(Buffer.from(chunks[0]?.payload.data as string, "base64").toString()).toBe(
      "There are three files."
    );
    expect(wire.some((w) => w.event === "voice:speaking-start")).toBe(true);
    expect(wire.some((w) => w.event === "voice:speaking-end")).toBe(true);
    expect(wire.some((w) => w.event === "voice:latency")).toBe(true);
    expect(wire.some((w) => w.event === "activity:event")).toBe(true);
  });

  it("applies the session's voiceModel for the turn and restores it after", async () => {
    const { io } = fakeIo();
    const { socket, fire } = fakeSocket();
    const { store, session, overrides } = fakeStore({
      id: "s1",
      model: "opus",
      voiceModel: "haiku",
    });
    let modelDuringSend: string | undefined;
    const sendMessage = vi.fn(async () => {
      modelDuringSend = session.model;
    });
    registerVoiceHandlers(io, socket, {
      store,
      processManager: fakeProcessManager({ isSessionBusy: () => false }),
      sendMessage,
    });

    fire("voice:start", { sessionId: "s1" });
    const pcm = new Int16Array(tone(400).length + silence(800).length);
    pcm.set(tone(400), 0);
    fire("voice:audio", { sessionId: "s1", pcm16: pcm });
    await wait(40);

    expect(overrides).toEqual(["haiku"]);
    expect(modelDuringSend).toBe("haiku");
    expect(session.model).toBe("opus");
  });

  it("voice:interrupt aborts a busy turn and voice:stop tears the session down", async () => {
    const { io, wire } = fakeIo();
    const { socket, fire } = fakeSocket();
    const { store } = fakeStore({ id: "s1" });
    const abort = vi.fn();
    registerVoiceHandlers(io, socket, {
      store,
      processManager: fakeProcessManager({ isSessionBusy: () => true, abort }),
      sendMessage: async () => undefined,
    });

    fire("voice:start", { sessionId: "s1" });
    io.to("s1").emit("message:stream:start", { sessionId: "s1" });
    io.to("s1").emit("message:stream:delta", { sessionId: "s1", delta: "Talking. " });
    await wait(30);
    expect(wire.some((w) => w.event === "voice:speaking-start")).toBe(true);

    fire("voice:interrupt", { sessionId: "s1" });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(wire.some((w) => w.event === "voice:stop-audio")).toBe(true);

    fire("voice:stop", { sessionId: "s1" });
    expect(getVoiceSession("s1")).toBeUndefined();
    expect(listVoiceSessions()).toEqual([]);
  });

  it("ignores stream traffic for sessions that have no voice session", async () => {
    const { io, wire } = fakeIo();
    const { socket, fire } = fakeSocket();
    const { store } = fakeStore({ id: "s1" });
    registerVoiceHandlers(io, socket, {
      store,
      processManager: fakeProcessManager(),
      sendMessage: async () => undefined,
    });
    fire("voice:start", { sessionId: "s1" });
    io.to("other").emit("message:stream:delta", { sessionId: "other", delta: "Hello. " });
    await wait(20);
    expect(wire.some((w) => w.event === "voice:audio-chunk")).toBe(false);
  });
});
