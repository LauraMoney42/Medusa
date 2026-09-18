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
import config from "../config.js";
import type { ChatStore } from "../chat/store.js";
import type { SessionStore } from "../sessions/store.js";
import type { ProcessManager } from "../claude/process-manager.js";
import { readVoice } from "../packs/store.js";
import {
  getSttProvider,
  getStreamingSttProvider,
  getTtsProvider,
  getRealtimeProvider,
} from "../voice/providers.js";
import { VoiceSession, type VoiceMode } from "../voice/session.js";
import type { VadOptions } from "../voice/vad.js";
import type { BargeInOptions } from "../voice/barge-in.js";
import {
  LiveVoiceSession,
  tierFromSettings,
  type TierDecision,
} from "../voice/live/live-session.js";
import { FOLLOWUP_SOURCE } from "../subagents/followups.js";

export interface VoiceHandlerDeps {
  store: SessionStore;
  processManager: ProcessManager;
  /**
   * Live mode posts both sides of the spoken conversation into the chat
   * itself, because no engine turn ever runs to do it. Optional so a caller
   * that only exercises the pipeline (the existing socket tests) needs no
   * store; a live session without one keeps talking but persists nothing.
   */
  chatStore?: Pick<ChatStore, "appendMessage">;
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

export function listVoiceSessions(): {
  sessionId: string;
  state: string;
  mode: string;
  tier: string;
}[] {
  return [
    ...[...sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      state: s.currentState,
      mode: s.currentMode,
      tier: "pipeline",
    })),
    ...[...liveSessions.values()].map((s) => ({
      sessionId: s.sessionId,
      state: s.currentState,
      mode: "always-on",
      tier: "live",
    })),
  ];
}

/**
 * Live-mode sessions, keyed by chat id. A chat is in exactly one map: `live`
 * routes audio to the realtime model, `pipeline` to the S14 loop.
 */
const liveSessions = new Map<string, LiveVoiceSession>();
/** The tier each chat is on right now, for `/api/voice/status`. */
const tiers = new Map<string, TierDecision>();
/**
 * Chats that were demoted mid-session by a provider error. Live is retried on
 * the next `voice:start`, so a quota blip costs one session, not the feature.
 */
const demoted = new Set<string>();

export function getLiveSession(sessionId: string): LiveVoiceSession | undefined {
  return liveSessions.get(sessionId);
}

export function getVoiceTier(sessionId: string): TierDecision | undefined {
  return tiers.get(sessionId);
}

/** Test seam: drop every live voice session. */
export function resetVoiceSessions(): void {
  for (const s of sessions.values()) s.dispose();
  sessions.clear();
  for (const s of liveSessions.values()) s.dispose();
  liveSessions.clear();
  tiers.clear();
  demoted.clear();
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
          // One voice owner per room: while Live holds the chat, the pipeline
          // session (if one lingers) must not synthesize the same stream too.
          const live = liveSessions.get(room);
          if (live) {
            handleTappedLiveEvent(live, data[0] as string, data[1]);
          } else {
            const session = sessions.get(room);
            if (session) handleTappedEvent(session, data[0] as string, data[1]);
          }
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
      // `message:stream:start` names the message with `id`, everything after
      // it with `messageId`; both identify the same turn. Passing it through
      // lets the session tell its own live turn apart from a stale one it
      // already replaced, rather than guessing from event order alone (see
      // the turn-identity comments on VoiceSession.isLiveTurn).
      session.onStreamStart(typeof body.id === "string" ? body.id : undefined);
      break;
    case "message:stream:delta":
      if (typeof body.delta === "string") {
        session.onDelta(body.delta, typeof body.messageId === "string" ? body.messageId : undefined);
      }
      break;
    case "message:stream:end":
      session.onStreamEnd(typeof body.messageId === "string" ? body.messageId : undefined);
      break;
    case "message:error":
      session.onStreamError(typeof body.messageId === "string" ? body.messageId : undefined);
      break;
  }
}

/**
 * The only room emission a live session cares about: a subagent follow-up.
 *
 * In Live mode no engine turn produced the spoken reply, so a follow-up that
 * only lands in the chat as text would never be said out loud. Injecting it
 * here rather than editing `subagents/followups.ts` keeps the follow-up
 * policy (dedupe, coalescing, the rate cap) in one place, and means a chat
 * that is not in Live mode behaves exactly as before.
 */
function handleTappedLiveEvent(
  live: LiveVoiceSession,
  event: string,
  payload: unknown
): void {
  if (event !== "message:user") return;
  const body = (payload ?? {}) as Record<string, unknown>;
  if (body.source !== FOLLOWUP_SOURCE) return;
  if (typeof body.text === "string") live.injectFollowup(body.text);
}

/** Build the session's `VoiceSession`, wiring it to this server's services. */
function createSession(
  io: IOServer,
  sessionId: string,
  deps: VoiceHandlerDeps,
  warmWanted: boolean
): VoiceSession {
  // The S16 knobs live on the same account-wide voice pack as the rest of
  // Settings > Voice. They are read here rather than taken from `voice:start`
  // so the client's voice bar does not have to know about them at all.
  let settings: ReturnType<typeof readVoice> | null = null;
  try {
    settings = readVoice();
  } catch (err) {
    console.warn("[voice] Could not read voice settings, using defaults:", err);
  }
  const partials = getStreamingSttProvider(settings?.partials ?? "local");

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
    partials,
    // The "Answer before you finish" toggle can always turn speculation off;
    // it only turns it ON when this call also warmed up the engine. Jumping
    // the gun buys nothing on a cold engine, whose ~10 s time-to-first-token
    // dwarfs the second or so speculation saves, so it defaults to on only
    // when warm.
    speculation: { enabled: (settings?.speculativeStart ?? true) && warmWanted },
    // 0 means "wait for a whole sentence", the S14 behavior.
    firstClauseChars: (settings?.firstClauseAudio ?? true) ? undefined : 0,
    warm: () => deps.processManager.isWarmMode(sessionId),
  });
}

/** Read the voice pack, tolerating a missing or broken file. */
function readVoiceSettings(): ReturnType<typeof readVoice> | null {
  try {
    return readVoice();
  } catch (err) {
    console.warn("[voice] Could not read voice settings, using defaults:", err);
    return null;
  }
}

/**
 * Which tier this chat gets, for one `voice:start`.
 *
 * A chat demoted mid-session by a provider error is pinned to the pipeline
 * until the next `voice:start`, at which point Live is tried again.
 */
export function decideTier(
  sessionId: string,
  settings: ReturnType<typeof readVoice> | null
): TierDecision {
  if (demoted.has(sessionId)) {
    return {
      tier: "pipeline",
      reason: "Local voice, after Live voice dropped out earlier in this session.",
    };
  }
  return tierFromSettings(settings, getRealtimeProvider);
}

/**
 * Tell the client which tier it is on, once per start and once per fallback.
 * `provider` rather than `providerId`, matching `/api/voice/status`.
 */
function emitTier(io: IOServer, sessionId: string, decision: TierDecision): void {
  io.to(sessionId).emit("voice:tier", {
    sessionId,
    tier: decision.tier,
    provider: decision.providerId ?? null,
    model: decision.model ?? null,
    reason: decision.reason,
  });
}

/** Start a live session for this chat, or fall through to the pipeline. */
function createLiveSession(
  io: IOServer,
  sessionId: string,
  deps: VoiceHandlerDeps,
  decision: TierDecision
): LiveVoiceSession | null {
  const meta = deps.store.get(sessionId);
  if (!meta) return null;
  const settings = readVoiceSettings();
  const provider = getRealtimeProvider(
    decision.providerId ?? "gemini-live",
    settings?.liveModel || undefined
  );
  if (!provider) return null;

  const emit = (event: string, payload: unknown) => io.to(sessionId).emit(event, payload);
  const activity = (summary: string, detail?: string) =>
    io.to(sessionId).emit("activity:event", {
      sessionId,
      ts: new Date().toISOString(),
      kind: "text",
      summary,
      ...(detail ? { detail } : {}),
    });

  const live = new LiveVoiceSession({
    sessionId,
    provider,
    // The realtime model reaches Medusa's own HTTP API for every tool call,
    // with this chat as the parent, exactly as the MCP shim would.
    shim: {
      url: `http://127.0.0.1:${config.port}`,
      token: config.authToken,
      parentSessionId: sessionId,
      toolsets: null,
    },
    emit,
    activity,
    chatStore: deps.chatStore ?? { appendMessage: () => undefined },
    session: {
      workingDir: meta.workingDir,
      systemPrompt: meta.systemPrompt,
      engineId: meta.engineId,
    },
    voice: settings ?? undefined,
    onFatal: (err) => fallbackToPipeline(io, sessionId, deps, err),
  });
  live.start();
  return live;
}

/**
 * A provider error mid-session (quota, auth, a dropped socket) must not leave
 * the user with a dead mic. Tear Live down, stand the pipeline up in its
 * place, say one short local line so the change is audible, and remember to
 * try Live again next time.
 */
function fallbackToPipeline(
  io: IOServer,
  sessionId: string,
  deps: VoiceHandlerDeps,
  err: Error
): void {
  const live = liveSessions.get(sessionId);
  if (!live) return;
  liveSessions.delete(sessionId);
  demoted.add(sessionId);
  live.dispose();

  const decision: TierDecision = {
    tier: "pipeline",
    reason: `Local voice, because Live voice failed: ${err.message}`,
  };
  tiers.set(sessionId, decision);
  emitTier(io, sessionId, decision);

  let warmWanted = true;
  try {
    warmWanted = readVoice().warmEngine;
  } catch {
    // Defaults win when the pack cannot be read.
  }
  const session = createSession(io, sessionId, deps, warmWanted);
  sessions.set(sessionId, session);
  session.start("always-on");

  void speakLocalLine(io, sessionId, "Switching to local voice.");
}

/**
 * One short line through the local TTS, outside any `VoiceSession`, so the
 * demotion is something the user hears rather than something they notice by
 * the silence. Best effort: if Kokoro is down too, the `voice:tier` event has
 * already said it on screen.
 */
async function speakLocalLine(io: IOServer, sessionId: string, text: string): Promise<void> {
  try {
    const { audio, mime } = await getTtsProvider().synthesize(text);
    io.to(sessionId).emit("voice:speaking-start", { sessionId });
    io.to(sessionId).emit("voice:audio-chunk", {
      sessionId,
      seq: 0,
      mime,
      data: audio.toString("base64"),
    });
    io.to(sessionId).emit("voice:speaking-end", { sessionId });
  } catch (err) {
    console.warn("[voice] could not speak the fallback line:", err);
  }
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
    ({
      sessionId,
      mode,
      vad,
      bargeIn,
    }: {
      sessionId: string;
      mode?: VoiceMode;
      vad?: VadOptions;
      bargeIn?: BargeInOptions;
    }) => {
      if (!sessionId || !deps.store.get(sessionId)) {
        socket.emit("error", { message: "Session not found" });
        return;
      }
      socket.join(sessionId);

      // Tier selection (S17). Voice always works: Live when a realtime key
      // exists and the user has not pinned the pipeline, the local loop
      // otherwise, and the client is told which one it got either way.
      const settings = readVoiceSettings();
      let decision = decideTier(sessionId, settings);
      if (decision.tier === "live" && !liveSessions.get(sessionId)) {
        sessions.get(sessionId)?.dispose();
        sessions.delete(sessionId);
        const live = createLiveSession(io, sessionId, deps, decision);
        if (live) {
          liveSessions.set(sessionId, live);
        } else {
          decision = {
            tier: "pipeline",
            reason: "Local voice, because the realtime provider could not be opened.",
          };
        }
      }
      tiers.set(sessionId, decision);
      emitTier(io, sessionId, decision);
      io.to(sessionId).emit("activity:event", {
        sessionId,
        ts: new Date().toISOString(),
        kind: "text",
        summary: `voice: ${decision.tier} tier`,
        detail: decision.reason,
      });
      if (decision.tier === "live") return;

      // Warm engine (S16): a voice session routes its turns through the
      // long-lived variant of its engine, so the CLI's start-up is paid once
      // per chat instead of once per sentence. On by default, and a no-op for
      // an engine with no warm variant. Computed before `createSession` (not
      // just before `setWarmMode`) because speculative start's own default
      // depends on it: jumping the gun on a cold engine's ~10 s time-to-first-
      // token just moves the wasted turn earlier, so speculation defaults to
      // on only when this call also asked for a warm engine.
      let warmWanted = true;
      try {
        warmWanted = readVoice().warmEngine;
      } catch {
        // Defaults win when the pack cannot be read.
      }
      let session = sessions.get(sessionId);
      if (!session) {
        session = createSession(io, sessionId, deps, warmWanted);
        sessions.set(sessionId, session);
      }
      const engineId = deps.processManager.setWarmMode(sessionId, warmWanted);
      if (engineId) {
        io.to(sessionId).emit("activity:event", {
          sessionId,
          ts: new Date().toISOString(),
          kind: "text",
          summary: `voice: engine ${engineId}${warmWanted ? " (warm)" : " (cold)"}`,
        });
      }
      session.start(mode ?? "always-on", vad, bargeIn);
    }
  );

  socket.on(
    "voice:audio",
    ({ sessionId, pcm16 }: { sessionId: string; pcm16: ArrayBuffer | Buffer | Uint8Array }) => {
      if (!pcm16) return;
      const live = liveSessions.get(sessionId);
      if (live) {
        live.pushAudio(pcm16);
        return;
      }
      sessions.get(sessionId)?.pushAudio(pcm16);
    }
  );

  socket.on("voice:stop", ({ sessionId }: { sessionId: string }) => {
    const live = liveSessions.get(sessionId);
    if (live) {
      liveSessions.delete(sessionId);
      tiers.delete(sessionId);
      // A clean stop is not a failure, so Live is the default again next time.
      demoted.delete(sessionId);
      live.dispose();
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) return;
    session.stop();
    session.dispose();
    sessions.delete(sessionId);
    tiers.delete(sessionId);
    // Voice off, so a demotion that happened during this session is spent:
    // the next time voice comes on, Live gets another try.
    demoted.delete(sessionId);
    // Voice off: typed turns go back to the cold path, which is what the rest
    // of the app expects and what keeps a warm process from idling forever.
    deps.processManager.setWarmMode(sessionId, false);
  });

  socket.on("voice:interrupt", ({ sessionId }: { sessionId: string }) => {
    const live = liveSessions.get(sessionId);
    if (live) {
      live.interrupt();
      return;
    }
    sessions.get(sessionId)?.interrupt();
  });
}
