/**
 * Live mode wiring: one realtime provider, dressed as the S14 voice contract.
 *
 * The point of this file is that the client does not learn anything new. A
 * live session emits exactly the Section 7 events a pipeline session emits
 * (`voice:state`, `voice:partial`, `voice:transcript`, `voice:audio-chunk`,
 * `voice:stop-audio`, `voice:speaking-start/end`, `voice:latency`) and posts
 * both sides of the conversation into the chat as ordinary messages, so the
 * mic button, the scheduler and the transcript rendering are untouched.
 *
 * Two translations happen here:
 *
 *  1. Audio. Gemini returns raw 24 kHz PCM16, and the client decodes chunks
 *     with `AudioContext.decodeAudioData`, which cannot read headerless PCM.
 *     Chunks are therefore buffered to about 200 ms and wrapped in a RIFF
 *     header, which is the same shape Kokoro already sends.
 *  2. Tier. `selectVoiceTier` decides Live vs pipeline once per `voice:start`,
 *     and a provider error mid-session demotes the chat to the pipeline
 *     rather than leaving voice broken. Voice always works.
 */

import { v4 as uuidv4 } from "uuid";
import type { ChatStore } from "../../chat/store.js";
import type { ShimEnv } from "../../mcp/client.js";
import { ALL_MCP_TOOLS } from "../../mcp/tools.js";
import type { Voice } from "../../packs/schema.js";
import { buildOrchestratorPrompt } from "../../sessions/orchestrator-prompt.js";
import { pcm16ToWav } from "../providers.js";
import type { RealtimeState, RealtimeVoiceProvider } from "../realtime.js";
import { GEMINI_OUTPUT_RATE, type LiveRealtimeSession } from "./gemini-live.js";

export type VoiceTier = "live" | "pipeline";

/** What the user chose in Settings > Voice > Live voice. */
export type LiveTierPreference = "auto" | "pipeline" | "live";

export interface TierDecision {
  tier: VoiceTier;
  /** The realtime provider id when the tier is `live`, else the one we wanted. */
  providerId?: string;
  model?: string;
  /** One sentence the UI shows verbatim, including how to move up for free. */
  reason: string;
}

/** The free-key hint, in one place so Settings and the socket agree. */
export const FREE_KEY_HINT =
  "Live voice is free: create a Google AI Studio key at " +
  "https://aistudio.google.com/apikey and paste it into Settings > Voice.";

export interface TierInputs {
  preference: LiveTierPreference;
  /** Preferred realtime provider id from settings. */
  providerId?: string;
  /** Resolve a provider id to an instance, or null when it has no key. */
  resolve: (id: string) => RealtimeVoiceProvider | null;
  /** Provider ids to try, best first, when settings name none. */
  candidates?: string[];
}

export const DEFAULT_REALTIME_CANDIDATES = ["gemini-live", "openai-realtime"];

/**
 * Pick the tier for one voice session.
 *
 * Never returns "no voice": the worst case is the local pipeline, which needs
 * no key at all. The `reason` is written to be read out to the user.
 */
export function selectVoiceTier(input: TierInputs): TierDecision {
  const candidates = input.candidates ?? DEFAULT_REALTIME_CANDIDATES;
  const wanted = input.providerId
    ? [input.providerId, ...candidates.filter((c) => c !== input.providerId)]
    : candidates;

  if (input.preference === "pipeline") {
    return {
      tier: "pipeline",
      providerId: input.providerId,
      reason: "Local voice, because Live voice is switched off in Settings.",
    };
  }

  for (const id of wanted) {
    const provider = input.resolve(id);
    if (provider?.isReady()) {
      return {
        tier: "live",
        providerId: provider.id,
        model: (provider as { model?: string }).model,
        reason: `Live voice through ${provider.displayName}.`,
      };
    }
  }

  return {
    tier: "pipeline",
    providerId: input.providerId,
    reason: `Local voice, because no realtime key is configured. ${FREE_KEY_HINT}`,
  };
}

/**
 * The tier a chat would get right now, from the voice pack alone.
 *
 * Shared by `voice:start` and `GET /api/voice/status` so the badge under the
 * mic and the Settings page cannot tell the user different things. The
 * mid-session demotion bookkeeping lives in the socket layer, which wraps
 * this; keeping the decision itself pure is what lets the status route stay
 * free of the socket module.
 */
export function tierFromSettings(
  settings: Partial<Voice> | null | undefined,
  resolve: (id: string, model?: string) => RealtimeVoiceProvider | null
): TierDecision {
  const model = settings?.liveModel || undefined;
  return selectVoiceTier({
    preference: (settings?.liveTier as LiveTierPreference) ?? "auto",
    providerId: settings?.liveProvider || undefined,
    resolve: (id) => resolve(id, model),
  });
}

// ---- The session --------------------------------------------------------

/** About 200 ms at 24 kHz: small enough to feel instant, big enough to decode. */
export const LIVE_CHUNK_SAMPLES = 4_800;

export interface LiveSessionDeps {
  sessionId: string;
  provider: RealtimeVoiceProvider;
  /** How the realtime model reaches Medusa's own HTTP API for tool calls. */
  shim: ShimEnv;
  emit: (event: string, payload: unknown) => void;
  activity: (summary: string, detail?: string) => void;
  chatStore: Pick<ChatStore, "appendMessage">;
  /** The chat's folder and per-chat notes, for the system instruction. */
  session: { workingDir: string; systemPrompt?: string; engineId?: string };
  voice?: Partial<Voice>;
  /**
   * The provider gave up (quota, auth, network). The caller demotes the chat
   * to the pipeline; this is called at most once.
   */
  onFatal: (err: Error) => void;
  now?: () => number;
}

/**
 * Map the provider's own states onto the four the client knows. `connecting`
 * reads as thinking rather than idle so the mic button never looks dead while
 * the socket comes up.
 */
export function toLoopState(state: RealtimeState): string {
  switch (state) {
    case "connecting":
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "listening":
      return "listening";
    default:
      return "idle";
  }
}

export class LiveVoiceSession {
  readonly sessionId: string;
  readonly tier: VoiceTier = "live";
  private readonly deps: LiveSessionDeps;
  private readonly now: () => number;
  private realtime: LiveRealtimeSession | null = null;

  private state: RealtimeState = "connecting";
  private seq = 0;
  private pending: number[] = [];
  private speakingEmitted = false;
  /**
   * One id per spoken turn, exactly as `VoiceSession` assigns for the
   * pipeline tier. The client scheduler keys single-speaker ownership off
   * this: `voice:speaking-start` tells it a new turn began (so it hard-stops
   * whatever was still queued from the last one) and every chunk carries the
   * turn it belongs to (so a chunk that finishes decoding after its turn was
   * interrupted is dropped instead of being played on top of the new reply).
   * Live mode emitted none of these, which left both protections inert and
   * was what made her talk over herself. Null between turns.
   */
  private currentTurnId: string | null = null;
  /**
   * True between an interrupt we raised and the service acknowledging it.
   * Audio that arrives in that window belongs to the turn that was cut off.
   */
  private suppressAudio = false;
  /** Set only for the duration of our own `interrupt()` call, to tell the two paths apart. */
  private localInterrupt = false;
  private suppressTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SUPPRESS_TIMEOUT_MS = 4_000;
  private fatal = false;
  private disposed = false;

  /** The assistant message currently being filled in by output transcription. */
  private assistantMessageId: string | null = null;
  private assistantText = "";

  private userTurnEndedAt: number | null = null;
  private firstAudioAt: number | null = null;

  constructor(deps: LiveSessionDeps) {
    this.deps = deps;
    this.sessionId = deps.sessionId;
    this.now = deps.now ?? Date.now;
  }

  get currentState(): string {
    return toLoopState(this.state);
  }

  /** Open the socket and start translating. */
  start(): void {
    if (this.realtime) return;
    const instructions = this.buildInstructions();
    this.realtime = this.deps.provider.open({
      instructions,
      tools: this.deps.shim,
      toolSpecs: ALL_MCP_TOOLS,
      // liveVoice names a realtime speaker; voiceId is a local Kokoro voice and
      // means nothing to a realtime provider (Gemini closes the socket with 1007).
      voice: this.deps.voice?.liveVoice || undefined,
      onState: (state) => this.handleState(state),
      onUserPartial: (text) =>
        this.deps.emit("voice:partial", { sessionId: this.sessionId, text }),
      onUserTranscript: (text) => this.handleUserTranscript(text),
      onAssistantDelta: (delta) => this.handleAssistantDelta(delta),
      onAssistantTranscript: (text) => this.handleAssistantTranscript(text),
      onAudio: (chunk) => this.handleAudio(chunk),
      onInterrupt: () => this.handleInterrupt(),
      onActivity: (summary, detail) => this.deps.activity(summary, detail),
      onError: (err) => this.handleError(err),
    }) as LiveRealtimeSession;
  }

  /**
   * The system instruction is Medusa's own orchestrator prompt in voice mode,
   * so the realtime model gets the same persona, the same folder discipline
   * and the same two-lane rule the engines get. The tool names are the bare
   * MCP names because that is what the function declarations are called.
   */
  private buildInstructions(): string {
    return buildOrchestratorPrompt({
      // Deliberately not the chat's engineId: the realtime model sees bare
      // tool names, not the claude CLI's `mcp__medusa__` spelling.
      engineId: undefined,
      workingDir: this.deps.session.workingDir,
      sessionSystemPrompt: this.deps.session.systemPrompt,
      voiceMode: true,
      liveTools: true,
    });
  }

  pushAudio(pcm16: ArrayBuffer | Buffer | Uint8Array): void {
    if (!this.realtime || this.disposed) return;
    const view = toInt16(pcm16);
    if (view.length > 0) this.realtime.pushAudio(view);
  }

  /** Push-to-talk release. */
  commit(): void {
    this.realtime?.commit();
  }

  /**
   * Cut her off from our side: the interrupt button, or the client hearing
   * the user talk over her (which it notices about a second before the
   * service's own VAD does).
   *
   * The service does not know yet, so it keeps sending audio for the turn we
   * just stopped. Those chunks would otherwise open a brand new turn here and
   * she would carry on talking after being told to stop, so audio is dropped
   * until the service confirms the interruption, the user's next turn is
   * transcribed, or the guard times out.
   */
  interrupt(): void {
    if (!this.realtime) return;
    this.localInterrupt = true;
    this.suppressAudio = true;
    this.armSuppressionTimeout();
    try {
      this.realtime.interrupt();
    } finally {
      this.localInterrupt = false;
    }
  }

  /** Never let a missing confirmation leave her permanently mute. */
  private armSuppressionTimeout(): void {
    if (this.suppressTimer) clearTimeout(this.suppressTimer);
    this.suppressTimer = setTimeout(() => {
      this.suppressAudio = false;
      this.suppressTimer = null;
    }, LiveVoiceSession.SUPPRESS_TIMEOUT_MS);
    // A stray timer must not hold the process open.
    (this.suppressTimer as unknown as { unref?: () => void }).unref?.();
  }

  private releaseSuppression(): void {
    this.suppressAudio = false;
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer);
      this.suppressTimer = null;
    }
  }

  /**
   * A subagent follow-up reaches the live model as an injected turn, so she
   * says it out loud instead of it landing only as text in the chat.
   */
  injectFollowup(text: string): void {
    if (!this.realtime || !text.trim()) return;
    // A provider that cannot take a text turn (OpenAI Realtime, today) simply
    // does not get the follow-up spoken; the chat still shows it.
    if (typeof this.realtime.injectTurn !== "function") return;
    this.realtime.injectTurn(
      `[System] A subagent you started just finished. Tell the user about it in ` +
        `one or two sentences, out loud, right now:\n\n${text}`
    );
    this.deps.activity("live: follow-up injected", text.slice(0, 200));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseSuppression();
    // Voice off (or a demotion to the pipeline) means stop, not "play the
    // last 200 ms first". Flushing here used to push a final chunk out after
    // the tier had already changed, which the pipeline session then talked
    // over.
    if (this.speakingEmitted || this.pending.length > 0) this.abortSpokenTurn();
    this.finishAssistantMessage();
    this.realtime?.close();
    this.realtime = null;
  }

  // ---- provider -> socket ---------------------------------------------

  private handleState(state: RealtimeState): void {
    if (this.state === state) return;
    this.state = state;
    if (state === "speaking") {
      // Audio for a turn the user cut off is still coming; that is not a new
      // turn and must not put the client back into "speaking" (which would
      // duck its mic again for a reply nobody will hear). `startSpeaking`
      // emits the state itself when a turn really does open.
      if (this.suppressAudio) return;
      this.startSpeaking();
      return;
    }
    this.endSpeaking();
    this.deps.emit("voice:state", {
      sessionId: this.sessionId,
      state: toLoopState(state),
    });
  }

  /**
   * Open a spoken turn: a fresh `turnId`, a `seq` counter that starts at 0
   * again (the client resets its own expectation on every turn change) and an
   * empty sample buffer, so nothing from the previous turn can leak into this
   * one. Idempotent, because audio and the state change race in the provider.
   */
  private startSpeaking(): void {
    if (this.speakingEmitted) return;
    this.speakingEmitted = true;
    this.currentTurnId = uuidv4();
    this.seq = 0;
    this.pending = [];
    this.deps.emit("voice:speaking-start", {
      sessionId: this.sessionId,
      turnId: this.currentTurnId,
    });
    // The client's echo guard keys off `voice:state`, and a turn can open on
    // the first audio chunk rather than on the provider's state change, so
    // the state goes out with the turn rather than only from `handleState`.
    this.deps.emit("voice:state", { sessionId: this.sessionId, state: "speaking" });
  }

  /** Close a spoken turn, flushing the tail of the buffer under its own id. */
  private endSpeaking(): void {
    if (!this.speakingEmitted) return;
    this.flushAudio();
    this.speakingEmitted = false;
    const turnId = this.currentTurnId;
    this.currentTurnId = null;
    this.deps.emit("voice:speaking-end", { sessionId: this.sessionId, turnId });
  }

  private handleUserTranscript(text: string): void {
    const messageId = uuidv4();
    const timestamp = new Date().toISOString();
    this.userTurnEndedAt = this.now();
    this.firstAudioAt = null;
    // A new user turn always ends the suppression window: whatever she says
    // next is an answer to this, not the tail of the turn that was cut off.
    this.releaseSuppression();

    const msg = {
      id: messageId,
      sessionId: this.sessionId,
      role: "user" as const,
      text,
      timestamp,
      // Distinct from the pipeline's "voice" so the chat can tell which tier
      // produced the turn without asking the server.
      source: "voice-live",
    };
    this.deps.emit("message:user", msg);
    this.deps.emit("voice:partial", { sessionId: this.sessionId, text: "" });
    this.deps.emit("voice:transcript", { sessionId: this.sessionId, text, messageId });
    try {
      this.deps.chatStore.appendMessage(msg);
    } catch (err) {
      console.error("[voice/live] could not persist user message:", err);
    }
  }

  private handleAssistantDelta(delta: string): void {
    if (!this.assistantMessageId) {
      this.assistantMessageId = uuidv4();
      this.assistantText = "";
      this.deps.emit("message:stream:start", {
        id: this.assistantMessageId,
        sessionId: this.sessionId,
        role: "assistant",
        text: "",
        timestamp: new Date().toISOString(),
      });
    }
    this.assistantText += delta;
    this.deps.emit("message:stream:delta", {
      sessionId: this.sessionId,
      messageId: this.assistantMessageId,
      delta,
    });
  }

  private handleAssistantTranscript(text: string): void {
    // Output transcription already streamed the same words; this is the
    // settled version, and the only place a turn with no deltas is caught.
    if (!this.assistantMessageId) {
      this.handleAssistantDelta(text);
    } else if (text.length > this.assistantText.length && text.startsWith(this.assistantText)) {
      this.handleAssistantDelta(text.slice(this.assistantText.length));
    }
    this.finishAssistantMessage();
  }

  private finishAssistantMessage(): void {
    const messageId = this.assistantMessageId;
    if (!messageId) return;
    const text = this.assistantText;
    this.assistantMessageId = null;
    this.assistantText = "";
    this.deps.emit("message:stream:end", { sessionId: this.sessionId, messageId });
    try {
      this.deps.chatStore.appendMessage({
        id: messageId,
        sessionId: this.sessionId,
        role: "assistant",
        text,
        timestamp: new Date().toISOString(),
        source: "voice-live",
      });
    } catch (err) {
      console.error("[voice/live] could not persist assistant message:", err);
    }
    this.emitLatency();
  }

  private handleAudio(chunk: { seq: number; mime: string; data: string }): void {
    // Audio for a turn the user already cut off: the service has not caught
    // up with the interruption yet. Dropping it is what stops her finishing a
    // sentence nobody is listening to any more.
    if (this.suppressAudio) return;
    if (this.firstAudioAt === null) this.firstAudioAt = this.now();
    // Audio can reach us before the provider's state change does; a chunk
    // must never be emitted without a turn to belong to.
    this.startSpeaking();
    const pcm = base64ToInt16(chunk.data);
    for (let i = 0; i < pcm.length; i++) this.pending.push(pcm[i] as number);
    while (this.pending.length >= LIVE_CHUNK_SAMPLES) {
      this.emitWav(this.pending.splice(0, LIVE_CHUNK_SAMPLES));
    }
  }

  private flushAudio(): void {
    if (this.pending.length === 0) return;
    this.emitWav(this.pending.splice(0));
  }

  private emitWav(samples: number[]): void {
    const wav = pcm16ToWav(Int16Array.from(samples), GEMINI_OUTPUT_RATE);
    this.deps.emit("voice:audio-chunk", {
      sessionId: this.sessionId,
      seq: this.seq++,
      turnId: this.currentTurnId,
      mime: "audio/wav",
      data: wav.toString("base64"),
    });
  }

  private handleInterrupt(): void {
    // Raised by the service rather than by us: the interruption we were
    // waiting for, so audio may flow again.
    if (!this.localInterrupt) this.releaseSuppression();
    // Barge-in: drop what has not been sent and tell the client to stop what
    // it is already playing. `stop-audio` names the turn being cut off, so a
    // chunk of that turn still decoding on the client is dropped rather than
    // scheduled on top of the reply that replaces it.
    this.abortSpokenTurn();
    // An interrupted reply is still what she said up to that point.
    this.finishAssistantMessage();
  }

  /**
   * Stop the turn in progress everywhere: nothing buffered here, nothing
   * queued on the client, and no id left that a late chunk could ride in on.
   */
  private abortSpokenTurn(): void {
    // Idempotent. The client now cuts her off locally the moment it hears the
    // user, and Gemini's own VAD reports the same interruption a beat later;
    // a second `stop-audio` with no turn to name would flush whatever turn had
    // started in between.
    if (!this.speakingEmitted && !this.currentTurnId && this.pending.length === 0) return;
    const turnId = this.currentTurnId;
    this.pending = [];
    this.seq = 0;
    this.deps.emit("voice:stop-audio", { sessionId: this.sessionId, turnId });
    if (this.speakingEmitted) {
      this.speakingEmitted = false;
      this.deps.emit("voice:speaking-end", { sessionId: this.sessionId, turnId });
    }
    this.currentTurnId = null;
  }

  private emitLatency(): void {
    if (this.userTurnEndedAt === null) return;
    const firstAudioMs =
      this.firstAudioAt === null ? undefined : this.firstAudioAt - this.userTurnEndedAt;
    this.deps.emit("voice:latency", {
      sessionId: this.sessionId,
      firstAudioMs,
      totalMs: this.now() - this.userTurnEndedAt,
      live: true,
    });
    this.userTurnEndedAt = null;
  }

  /** Mid-session closes from the service (a model error, a hiccup) get one retry before the chat drops to the pipeline. */
  private reconnects = 0;
  private static readonly MAX_RECONNECTS = 1;

  private handleError(err: Error): void {
    if (this.fatal || this.disposed) return;
    const closedByService = /closed \((10\d\d)/.test(err.message);
    if (closedByService && this.reconnects < LiveVoiceSession.MAX_RECONNECTS) {
      this.reconnects += 1;
      this.deps.activity("voice: live session dropped, reconnecting", err.message);
      // The new socket is a new conversation: end the turn that died rather
      // than flushing its tail, so the client starts the reconnected turn
      // from a clean queue instead of waiting for a seq that will never come.
      this.abortSpokenTurn();
      this.realtime = null;
      this.state = "connecting";
      try {
        this.start();
        return;
      } catch (openErr) {
        err = openErr instanceof Error ? openErr : new Error(String(openErr));
      }
    }
    this.fatal = true;
    this.deps.activity("voice: live mode failed", err.message);
    this.deps.onFatal(err);
  }
}

// ---- helpers ------------------------------------------------------------

/** Socket frames arrive as ArrayBuffer, Buffer or Uint8Array depending on transport. */
export function toInt16(input: ArrayBuffer | Buffer | Uint8Array): Int16Array {
  if (input instanceof ArrayBuffer) {
    return new Int16Array(input, 0, Math.floor(input.byteLength / 2));
  }
  const view = input as Uint8Array;
  return new Int16Array(
    view.buffer,
    view.byteOffset,
    Math.floor(view.byteLength / 2)
  );
}

export function base64ToInt16(data: string): Int16Array {
  const buf = Buffer.from(data, "base64");
  const out = new Int16Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}
