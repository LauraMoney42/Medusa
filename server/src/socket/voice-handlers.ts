/**
 * Socket wiring for the voice loop (S14-A).
 *
 * Two jobs:
 *
 *  1. The client -> server half of the Section 7 contract (`voice:start`,
 *     `voice:audio`, `voice:stop`, `voice:interrupt`).
 *  2. Tapping the assistant text stream so it can be spoken. The send path in
 *     `handler.ts` broadcasts `message:stream:delta` into the session room; the
 *     tap below wraps the namespace adapter's `broadcast` so the voice session
 *     sees the same events the browser does. That keeps `handler.ts` to the one
 *     registration line this workstream owns, and means the voice layer cannot
 *     drift out of step with what the client is actually rendering.
 *
 * The same tap is what tags a voice-originated `message:user` with
 * `source: "voice"` on its way out.
 */

import type { Server as IOServer } from "socket.io";
import type { Socket } from "socket.io";
import type { SessionStore } from "../sessions/store.js";
import type { ProcessManager } from "../claude/process-manager.js";
import { getSttProvider, getTtsProvider } from "../voice/providers.js";
import { VoiceSession, type VoiceMode } from "../voice/session.js";
import type { VadOptions } from "../voice/vad.js";

export interface VoiceHandlerDeps {
  store: SessionStore;
  processManager: ProcessManager;
  /** The normal send path from `handler.ts`. */
  sendMessage(
    sessionId: string,
    text: string,
    images?: string[],
    files?: string[]
  ): Promise<void>;
}

/** Live voice sessions, keyed by chat id. Exported for `/api/voice/status`. */
const sessions = new Map<string, VoiceSession>();

export function getVoiceSession(sessionId: string): VoiceSession | undefined {
  return sessions.get(sessionId);
}

export function listVoiceSessions(): { sessionId: string; state: string; mode: string }[] {
  return [...sessions.values()].map((s) => ({
    sessionId: s.sessionId,
    state: s.currentState,
    mode: s.currentMode,
  }));
}

/** Test seam: drop every live voice session. */
export function resetVoiceSessions(): void {
  for (const s of sessions.values()) s.dispose();
  sessions.clear();
}

/** io servers whose adapter has already been wrapped. */
const tapped = new WeakSet<object>();

/** The one adapter method the tap wraps. */
interface TappableAdapter {
  broadcast: (
    packet: { type: number; data?: unknown[] },
    opts: { rooms?: Set<string> }
  ) => void;
}

/**
 * Wrap the namespace adapter's `broadcast` so every room emission is mirrored
 * into the matching voice session before it is encoded. Returning through the
 * original keeps delivery semantics identical; a throw in the tap is swallowed
 * so a voice bug can never break the chat.
 */
function installStreamTap(io: IOServer): void {
  // The project's ambient socket.io declaration (src/types/socket.io.d.ts) is a
  // trimmed subset that does not describe namespaces, so reach the default
  // namespace's adapter structurally rather than through the typed API.
  const adapter = (io as unknown as { sockets?: { adapter?: TappableAdapter } }).sockets
    ?.adapter;
  if (!adapter || typeof adapter.broadcast !== "function") return;
  if (tapped.has(adapter)) return;
  tapped.add(adapter);

  const original = adapter.broadcast.bind(adapter);
  adapter.broadcast = (packet, opts) => {
    try {
      const data = packet?.data;
      if (Array.isArray(data) && typeof data[0] === "string" && opts?.rooms?.size) {
        for (const room of opts.rooms) {
          const session = sessions.get(room);
          if (session) handleTappedEvent(session, data[0] as string, data[1]);
        }
      }
    } catch (err) {
      console.error("[voice] stream tap error:", err);
    }
    return original(packet, opts);
  };
}

/** Route one tapped room emission into the voice session. */
function handleTappedEvent(session: VoiceSession, event: string, payload: unknown): void {
  const body = (payload ?? {}) as Record<string, unknown>;
  switch (event) {
    case "message:user":
      // Tag the echo of a transcript so the client can render it as speech.
      if (session.expectsVoiceTag() && body.role === "user") body.source = "voice";
      break;
    case "message:stream:start":
      session.onStreamStart();
      break;
    case "message:stream:delta":
      if (typeof body.delta === "string") session.onDelta(body.delta);
      break;
    case "message:stream:end":
      session.onStreamEnd();
      break;
    case "message:error":
      session.onStreamError();
      break;
  }
}

/** Build the session's `VoiceSession`, wiring it to this server's services. */
function createSession(io: IOServer, sessionId: string, deps: VoiceHandlerDeps): VoiceSession {
  return new VoiceSession({
    sessionId,
    emit: (event, payload) => io.to(sessionId).emit(event, payload),
    activity: (summary, detail) =>
      io.to(sessionId).emit("activity:event", {
        sessionId,
        ts: new Date().toISOString(),
        kind: "text",
        summary,
        ...(detail ? { detail } : {}),
      }),
    send: (text) => {
      // A per-session `voiceModel` (a fast tier for the conversation lane) is
      // applied for the duration of this turn only and never persisted.
      const meta = deps.store.get(sessionId);
      const restore = meta?.voiceModel
        ? deps.store.overrideModelForTurn(sessionId, meta.voiceModel)
        : null;
      void deps
        .sendMessage(sessionId, text)
        .catch((err) => console.error("[voice] send failed:", err))
        .finally(() => restore?.());
    },
    abortTurn: () => deps.processManager.abort(sessionId),
    isBusy: () => deps.processManager.isSessionBusy(sessionId),
    stt: getSttProvider(),
    tts: getTtsProvider(),
  });
}

/**
 * Register the voice events on one socket. Called from `handler.ts` inside the
 * connection handler, with the send path passed in.
 */
export function registerVoiceHandlers(
  io: IOServer,
  socket: Socket,
  deps: VoiceHandlerDeps
): void {
  installStreamTap(io);

  socket.on(
    "voice:start",
    ({ sessionId, mode, vad }: { sessionId: string; mode?: VoiceMode; vad?: VadOptions }) => {
      if (!sessionId || !deps.store.get(sessionId)) {
        socket.emit("error", { message: "Session not found" });
        return;
      }
      socket.join(sessionId);
      let session = sessions.get(sessionId);
      if (!session) {
        session = createSession(io, sessionId, deps);
        sessions.set(sessionId, session);
      }
      session.start(mode ?? "always-on", vad);
    }
  );

  socket.on(
    "voice:audio",
    ({ sessionId, pcm16 }: { sessionId: string; pcm16: ArrayBuffer | Buffer | Uint8Array }) => {
      const session = sessions.get(sessionId);
      if (!session || !pcm16) return;
      session.pushAudio(pcm16);
    }
  );

  socket.on("voice:stop", ({ sessionId }: { sessionId: string }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.stop();
    session.dispose();
    sessions.delete(sessionId);
  });

  socket.on("voice:interrupt", ({ sessionId }: { sessionId: string }) => {
    sessions.get(sessionId)?.interrupt();
  });
}
