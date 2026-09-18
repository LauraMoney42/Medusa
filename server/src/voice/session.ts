/**
 * One `VoiceSession` per chat with voice mode on.
 *
 * It is the state machine from the S14 spec
 * (`idle -> listening -> transcribing -> thinking -> speaking -> listening`)
 * plus the two things that make the loop feel like a conversation: barge-in,
 * and per-turn latency accounting.
 *
 * Everything the session needs from the rest of the server arrives as
 * callbacks (`VoiceSessionDeps`), so the whole machine is testable without a
 * socket, a process manager, or an HTTP backend.
 */

import { randomUUID } from "crypto";
import type { SttProvider, TtsProvider } from "./providers.js";
import {
  SpeculationTracker,
  shouldAbortSpeculation,
  type SpeculationOptions,
} from "./speculation.js";
import type { StreamingSttProvider } from "./streaming-stt.js";
import { SttStream } from "./stt-stream.js";
import { TtsStream, type AudioChunk } from "./tts-stream.js";
import type { VadOptions } from "./vad.js";
import { BargeInDetector, type BargeInOptions } from "./barge-in.js";

export type VoiceState = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

export type VoiceMode = "off" | "push-to-talk" | "always-on";

/** Per-turn stage timings, in millis. Mirrors the `voice:latency` payload. */
export interface VoiceLatency {
  /** Speech end -> final transcript (the Whisper round trip). */
  sttMs: number;
  /** Transcript -> first assistant delta. */
  firstTokenMs: number;
  /** First complete sentence -> first audio chunk (the Kokoro round trip). */
  firstAudioMs: number;
  /** Speech end -> first audio chunk. This is the "time to first word". */
  totalMs: number;
}

export interface VoiceSessionDeps {
  sessionId: string;
  /** Broadcast one event to the session's room. */
  emit(event: string, payload: Record<string, unknown>): void;
  /** Append one line to the Activity Log. */
  activity(summary: string, detail?: string): void;
  /** Post a user message through the normal send path, tagged `source: "voice"`. */
  send(text: string): void;
  /** Abort the in-flight assistant turn (the `message:abort` path). */
  abortTurn(): void;
  /** True while the engine is mid-turn for this session. */
  isBusy(): boolean;
  stt: SttProvider;
  tts: TtsProvider;
  /** Kokoro voice id; falls back to the configured default. */
  voice?: string;
  vad?: VadOptions;
  bargeIn?: BargeInOptions;
  /**
   * S16 partial-hypothesis source. Absent (or null) keeps the S14 behavior:
   * no `voice:partial`, and no speculative start (which reads partials).
   */
  partials?: StreamingSttProvider | null;
  /** S16 speculative start tuning. `enabled: false` switches it off. */
  speculation?: SpeculationOptions;
  /**
   * S16: cut the first chunk of a reply at a clause boundary or this many
   * characters. 0 restores the S14 behavior of waiting for a whole sentence.
   */
  firstClauseChars?: number;
  /**
   * True when this session's engine is running warm. Only used to label the
   * latency line in the Activity Log, so cold and warm turns can be compared.
   */
  warm?: () => boolean;
}

/** One entry in a session's debug ring buffer (`GET /api/voice/status?events=1`). */
export interface VoiceEvent {
  ts: number;
  type: "state" | "ignored-onset" | "barge-in" | "latency";
  detail: Record<string, unknown>;
}

/** Ring buffer size for `VoiceSession.getEvents()`. */
const EVENT_LOG_SIZE = 200;

/** Prefix prepended to the re-prompt after the user talks over the reply. */
export function interruptionPrefix(lastSpoken: string): string {
  return `[You interrupted; the previous reply was cut off after: "${lastSpoken}"]\n`;
}

export class VoiceSession {
  readonly sessionId: string;

  private readonly deps: VoiceSessionDeps;
  private stt: SttStream | null = null;
  private tts: TtsStream | null = null;

  private state: VoiceState = "idle";
  private mode: VoiceMode = "off";

  /** Partial-hypothesis watcher for the speculative start (S16). */
  private readonly speculation: SpeculationTracker;
  /** The hypothesis a speculative turn was started on, "" when none. */
  private speculativeText = "";
  /** Per-turn counters for the Activity Log. */
  private speculativeStarts = 0;
  private speculativeAborts = 0;
  /** True when the current turn's latency was measured on a speculative start. */
  private turnWasSpeculative = false;

  // ---- per-turn timing ----
  private speechEndedAt = 0;
  private sttMs = 0;
  private transcriptAt = 0;
  /** When the prompt actually went to the engine (speculative or not). */
  private turnStartedAt = 0;
  private firstTokenMs = 0;
  private firstSentenceAt = 0;
  private firstAudioEmitted = false;
  private latencyReported = false;

  /** True between "the user talked over the reply" and the re-prompt going out. */
  private bargingIn = false;
  /** Last sentence actually sent to the client; survives the TTS stream's death. */
  private lastSpoken = "";
  private speakingStartEmitted = false;
  /**
   * False between starting a turn and seeing that turn's `message:stream:start`.
   * It is what stops the tail of an abandoned turn (a speculative start the
   * real transcript corrected) from being spoken, or from reporting its
   * latency as though it belonged to the turn that replaced it.
   */
  private streamStarted = false;
  /**
   * Identity of the turn currently allowed to speak, set from the real
   * `message:stream:start` payload (its `id`) once it arrives. Every
   * subsequent delta/end/error the tap forwards carries the same id when the
   * caller (`voice-handlers.ts`) has one to give, and is compared here before
   * touching this session's state.
   *
   * This replaces an earlier counter (`abandonedTurns`) that just counted how
   * many stale end/error events to swallow: it worked only if those events
   * arrived in the same order the turns were abandoned, which is not
   * guaranteed. When a stale event from an old, aborted turn arrived AFTER
   * the live turn's own terminal event, the counter swallowed the live turn's
   * end instead and the reply was never spoken (the "sometimes shows no
   * response" bug). Matching on the turn's real id is order-independent: an
   * event either belongs to the live turn or it does not, regardless of when
   * it shows up. `undefined` (no id given, e.g. in tests that call these
   * methods directly) is treated as "matches", preserving the old
   * single-turn-at-a-time behavior for callers that never pass one.
   */
  private liveMessageId: string | undefined = undefined;
  /**
   * Real message ids of turns known to have been explicitly replaced (a
   * corrected speculative start, or a barge-in), recorded whenever we abort
   * one that had already reached `onStreamStart`. A stale end/delta/error for
   * one of these is rejected outright even if it arrives before the new
   * turn's own `message:stream:start` (so `liveMessageId` is still
   * `undefined` and cannot rule it out by comparison alone). Trimmed so a
   * long always-on session cannot grow this without bound.
   */
  private readonly abandonedMessageIds = new Set<string>();
  /**
   * Local turn token, independent of the engine's own message id. Carried on
   * every `voice:audio-chunk`, `voice:speaking-start/end` and
   * `voice:stop-audio` so the client can drop audio that belongs to a turn it
   * has already moved past (see `audioScheduler.ts`), which is what stops a
   * superseded speculative turn's late chunk from overlapping the reply that
   * replaced it.
   */
  private turnId = "";
  /** Set while a voice-originated send is in flight, so the tap can tag it. */
  private awaitingTurn = false;
  /** True once `onDelta` has seen real text for the turn in progress. */
  private turnHadText = false;
  /** True once the TTS-failure warning has been logged for this turn. */
  private noAudioWarned = false;

  /** Distinguishes her own echo from a real interruption; armed while thinking/speaking. */
  private bargeIn: BargeInDetector;
  /** True when the in-flight utterance was flagged as echo; its transcript gets dropped. */
  private ignoredEchoOnset = false;
  /** Last `EVENT_LOG_SIZE` voice events, for the owner to pull via the status endpoint. */
  private readonly events: VoiceEvent[] = [];

  constructor(deps: VoiceSessionDeps) {
    this.sessionId = deps.sessionId;
    this.deps = deps;
    this.bargeIn = new BargeInDetector(deps.bargeIn);
    // With no partial provider there is nothing to speculate on, so the
    // tracker is built disabled rather than silently never firing.
    this.speculation = new SpeculationTracker({
      ...(deps.speculation ?? {}),
      enabled: Boolean(deps.partials) && (deps.speculation?.enabled ?? true),
    });
  }

  /** Debug ring buffer: state changes, onsets, ignored onsets, barge-ins, latencies. */
  getEvents(): VoiceEvent[] {
    return this.events.slice();
  }

  private logEvent(type: VoiceEvent["type"], detail: Record<string, unknown>): void {
    this.events.push({ ts: Date.now(), type, detail });
    if (this.events.length > EVENT_LOG_SIZE) this.events.shift();
  }

  get currentState(): VoiceState {
    return this.state;
  }

  get currentMode(): VoiceMode {
    return this.mode;
  }

  /** True while this session expects the assistant stream to be spoken. */
  get active(): boolean {
    return this.state !== "idle";
  }

  /** Speculative-start counters, surfaced by `GET /api/voice/status`. */
  get speculationStats(): { starts: number; aborts: number } {
    return { starts: this.speculativeStarts, aborts: this.speculativeAborts };
  }

  // ---- lifecycle -------------------------------------------------------

  /** Voice mode on. Idempotent: a reconnecting client may call it again. */
  start(mode: VoiceMode = "always-on", vad?: VadOptions, bargeIn?: BargeInOptions): void {
    this.mode = mode === "off" ? "always-on" : mode;
    if (bargeIn) this.bargeIn = new BargeInDetector(bargeIn);
    if (!this.stt) {
      this.stt = new SttStream({
        provider: this.deps.stt,
        vad: vad ?? this.deps.vad,
        partials: this.deps.partials ?? null,
        onSpeechStart: () => this.handleSpeechStart(),
        onPartial: (text) => this.handlePartial(text),
        onSpeechEnd: (u) => {
          this.speechEndedAt = u.endedAt;
          this.finishBargeInOnset();
          this.setState("transcribing");
        },
        onTranscript: (text, meta) => this.handleTranscript(text, meta.sttMs),
        onError: (err) => {
          this.deps.activity(`voice: transcription failed: ${err.message}`);
          this.setState("listening");
        },
      });
      // Raw frame energy, independent of the base VAD's own gate, so the
      // barge-in detector can sample the mic continuously while she talks.
      this.stt.vad.onFrame = (energy) => this.handleVadFrame(energy);
    }
    this.setState("listening");
  }

  /** PCM16 frame from `voice:audio`. */
  pushAudio(chunk: Int16Array | ArrayBuffer | Buffer | Uint8Array): void {
    if (!this.stt || this.state === "idle") return;
    this.stt.pushAudio(chunk);
    // Audio frames are the clock the speculative start runs on: they arrive
    // about every 100 ms, so no timer is needed to notice a stable partial.
    this.checkSpeculation();
  }

  /** Voice mode off. Stops audio, drops the VAD buffer, releases the turn. */
  stop(): void {
    this.stt?.flush();
    this.stt?.close();
    this.stt = null;
    this.stopSpeaking();
    this.bargeIn.deactivate();
    this.streamStarted = false;
    this.liveMessageId = undefined;
    this.abandonedMessageIds.clear();
    this.mode = "off";
    this.setState("idle");
  }

  /** The client's explicit interrupt button. Same path as a spoken barge-in. */
  interrupt(): void {
    this.stopSpeaking();
    if (this.deps.isBusy()) {
      this.deps.abortTurn();
      this.deps.activity("voice: turn aborted by interrupt");
    }
    this.bargingIn = false;
    this.awaitingTurn = false;
    this.streamStarted = false;
    this.liveMessageId = undefined;
    this.speculativeText = "";
    this.speculation.reset();
    this.setState("listening");
  }

  dispose(): void {
    this.stt?.close();
    this.stt = null;
    this.tts?.cancel();
    this.tts = null;
    this.bargeIn.deactivate();
    this.streamStarted = false;
    this.liveMessageId = undefined;
    this.abandonedMessageIds.clear();
    this.state = "idle";
  }

  // ---- inbound audio ---------------------------------------------------

  /**
   * The VAD gate opened. While she is idle or listening this means nothing
   * extra; the base VAD's own onset already segments the utterance. While
   * she is thinking, speaking, or in the short grace window after, this
   * onset also becomes a barge-in candidate: `handleVadFrame` decides,
   * frame by frame, whether it is a real interruption (sustained loud
   * speech) or just her own voice leaking back through the mic.
   */
  private handleSpeechStart(): void {
    if (this.bargeIn.isActive) this.bargeIn.beginOnset();
  }

  /** Raw mic energy for one frame, from `Vad.onFrame`. Barge-in only. */
  private handleVadFrame(energy: number): void {
    const frameMs = this.stt?.vad.options.frameMs ?? 20;
    const decision = this.bargeIn.pushFrame(energy, frameMs);
    if (decision.kind !== "barging") return;
    // Real interruption, confirmed: stop audio now (about 100 ms, the time
    // the `voice:stop-audio` emit and client playback flush actually take).
    this.bargingIn = true;
    this.ignoredEchoOnset = false;
    this.stopSpeaking();
    const energyRounded = Math.round(decision.energy);
    this.deps.activity(`voice: barge-in confirmed (energy ${energyRounded}, ms ${decision.ms})`);
    this.logEvent("barge-in", { energy: energyRounded, ms: decision.ms });
  }

  /** The VAD onset that started this utterance just closed. */
  private finishBargeInOnset(): void {
    const ignored = this.bargeIn.endOnset();
    if (!ignored) {
      this.ignoredEchoOnset = false;
      return;
    }
    this.ignoredEchoOnset = true;
    const energyRounded = Math.round(ignored.energy);
    this.deps.activity(`voice: ignored echo onset (energy ${energyRounded}, ms ${ignored.ms})`);
    this.logEvent("ignored-onset", { energy: energyRounded, ms: ignored.ms });
  }

  /**
   * True while anything the mic hears is presumed to be her own voice coming
   * back through the speakers: the barge-in detector is armed (thinking,
   * speaking, or the grace window after) and has not yet confirmed a real
   * interruption, or the onset that is still open was already written off as
   * echo. Partials and speculative starts both stand down while this holds,
   * so S16 never builds a turn out of S14's echo.
   */
  private get echoSuspect(): boolean {
    if (this.bargingIn) return false;
    return this.bargeIn.isActive || this.ignoredEchoOnset;
  }

  /** One growing hypothesis for the utterance in progress. */
  private handlePartial(text: string): void {
    if (!this.active) return;
    // Her own reply leaking into the mic produces partials too. Showing them
    // as the user's live transcript is wrong, and feeding them to the
    // speculation tracker would start a turn on her own words.
    if (this.echoSuspect) return;
    this.deps.emit("voice:partial", { sessionId: this.sessionId, text });
    this.speculation.onPartial(text, Date.now());
    this.checkSpeculation();
  }

  /**
   * Start the engine turn before the user has finished, when the hypothesis
   * has stopped moving and reads like a finished thought. Never speculates
   * over a reply in progress: a barge-in needs the real transcript so the
   * "you interrupted" prefix quotes the right sentence, and never over an
   * onset the barge-in detector is still treating as echo.
   */
  private checkSpeculation(): void {
    if (!this.stt || this.bargingIn || this.state === "speaking") return;
    if (this.echoSuspect) return;
    if (this.deps.isBusy() || this.awaitingTurn) return;
    const candidate = this.speculation.check(Date.now());
    if (!candidate) return;

    this.speculativeText = candidate;
    this.turnWasSpeculative = true;
    this.speculativeStarts++;
    this.deps.activity(`voice: speculative start on "${candidate}"`);
    this.startTurn(candidate);
  }

  private handleTranscript(text: string, sttMs: number): void {
    // This utterance started during speaking/thinking and never earned a
    // real barge-in: it is her own words coming back through the mic, not
    // something the user said. Drop it before it becomes a chat message.
    if (this.ignoredEchoOnset) {
      this.ignoredEchoOnset = false;
      // Nothing should have speculated on an echo onset (`echoSuspect` gates
      // both the partials and `checkSpeculation`), but clear the hypothesis
      // anyway so a dropped transcript can never leave one standing.
      this.speculativeText = "";
      this.speculation.reset();
      this.deps.activity(`voice: dropped echo transcript "${text}"`);
      return;
    }

    this.sttMs = sttMs;
    this.transcriptAt = Date.now();
    const messageId = randomUUID();
    this.deps.emit("voice:transcript", { sessionId: this.sessionId, text, messageId });

    // A transcript that arrives while she is still talking is a barge-in even
    // if the VAD gate opened before playback started.
    const interrupting = this.bargingIn || this.state === "speaking";

    // A speculative turn is already running on the hypothesis. Keep it when
    // the real transcript says the same thing; otherwise throw it away and
    // start over on the truth.
    if (this.speculativeText && !interrupting) {
      const spoken = this.speculativeText;
      this.speculativeText = "";
      this.speculation.reset();
      if (!shouldAbortSpeculation(spoken, text)) {
        this.deps.activity(`voice: speculation held, transcript matched "${text}"`);
        return;
      }
      this.speculativeAborts++;
      this.turnWasSpeculative = false;
      this.stopSpeaking();
      if (this.deps.isBusy()) {
        this.deps.abortTurn();
        // The old turn's own end/error may still arrive after this; marking
        // its id abandoned now (rather than counting it) is what lets that
        // late event be recognized as stale regardless of when it shows up.
        this.markAbandoned();
      }
      this.deps.activity(
        `voice: speculation discarded, restarting on "${text}" (guessed "${spoken}")`
      );
      this.startTurn(text);
      return;
    }

    this.speculativeText = "";
    this.speculation.reset();
    this.turnWasSpeculative = false;

    let prompt = text;

    if (interrupting) {
      const lastSpoken = this.tts?.lastSpokenSentence || this.lastSpoken;
      this.stopSpeaking();
      if (this.deps.isBusy()) {
        this.deps.abortTurn();
        this.markAbandoned();
        this.deps.activity(`voice: aborted turn for barge-in after "${lastSpoken}"`);
      }
      if (lastSpoken) prompt = `${interruptionPrefix(lastSpoken)}${text}`;
    }
    this.bargingIn = false;
    this.startTurn(prompt);
  }

  /** Reset the per-turn clocks and hand the prompt to the engine. */
  private startTurn(prompt: string): void {
    this.firstTokenMs = 0;
    this.firstSentenceAt = 0;
    this.firstAudioEmitted = false;
    this.latencyReported = false;
    this.speakingStartEmitted = false;
    this.awaitingTurn = true;
    this.streamStarted = false;
    this.liveMessageId = undefined;
    this.turnHadText = false;
    this.noAudioWarned = false;
    this.turnId = randomUUID();
    this.turnStartedAt = Date.now();

    this.setState("thinking");
    this.deps.send(prompt);
  }

  // ---- assistant stream tap -------------------------------------------

  /**
   * True when a tapped stream event belongs to the turn this session is
   * currently running. `messageId` is `undefined` for callers that don't
   * track per-turn ids (unit tests calling these methods directly), which is
   * treated as a match so their single-turn scenarios are unaffected.
   */
  private isLiveTurn(messageId: string | undefined): boolean {
    if (messageId !== undefined && this.abandonedMessageIds.has(messageId)) return false;
    if (this.streamStarted) {
      if (messageId === undefined) return true;
      return messageId === this.liveMessageId;
    }
    // The turn has not reached its own `message:stream:start` yet, so there
    // is no id to compare against: an engine error can fail a turn before it
    // ever streams a token. This looks like the live turn's own early
    // failure exactly when we are still waiting on one turn's start; that
    // window only exists because `startTurn` just ran, so it is the turn we
    // care about. A known-stale id was already rejected above.
    return this.awaitingTurn;
  }

  /** Record a turn's id (if we ever learned one) as explicitly superseded. */
  private markAbandoned(): void {
    if (this.liveMessageId !== undefined) this.abandonedMessageIds.add(this.liveMessageId);
    if (this.abandonedMessageIds.size > 20) {
      const oldest = this.abandonedMessageIds.values().next().value;
      if (oldest !== undefined) this.abandonedMessageIds.delete(oldest);
    }
    this.streamStarted = false;
    this.liveMessageId = undefined;
  }

  /** A new assistant message started streaming for this session. */
  onStreamStart(messageId?: string): void {
    if (!this.active) return;
    this.awaitingTurn = false;
    this.streamStarted = true;
    this.liveMessageId = messageId;
    // Barge-in detection is armed from "thinking" onward, not just once
    // audio starts, so a fast interruption during the thinking gap is
    // still caught by the sustained-energy bar rather than the plain VAD.
    this.bargeIn.activate();
    // Cancel synchronously before attaching the replacement: a session must
    // never have two TtsStreams attached (and thus never two turns able to
    // call `deps.emit("voice:audio-chunk", ...)`) at once.
    this.tts?.cancel();
    this.tts = null;
    const turnId = this.turnId;
    this.tts = new TtsStream({
      synthesize: (t, v) => this.deps.tts.synthesize(t, v),
      voice: this.deps.voice,
      lookahead: 1,
      firstClauseChars: this.deps.firstClauseChars,
      onChunk: (chunk) => this.handleAudioChunk(chunk, turnId),
      onStart: () => {
        this.speakingStartEmitted = true;
        this.setState("speaking");
        this.bargeIn.beginPlayback();
        this.deps.emit("voice:speaking-start", { sessionId: this.sessionId, turnId });
      },
      onEnd: () => this.handleSpeakingEnd(turnId),
      onError: (err) => this.deps.activity(`voice: synthesis failed: ${err.message}`),
    });
    this.setState("thinking");
  }

  /** One assistant text delta. */
  onDelta(text: string, messageId?: string): void {
    if (!this.active || !text) return;
    // A delta from a turn that was abandoned mid-flight, or from a foreign
    // (non-voice) turn: the live turn's own `message:stream:start` either
    // has not arrived yet, or belongs to a different message id.
    if (!this.isLiveTurn(messageId)) return;
    this.turnHadText = true;
    // Measured from when the prompt went out, which is the transcript for a
    // normal turn and the stable partial for a speculative one.
    if (this.firstTokenMs === 0 && this.turnStartedAt > 0) {
      this.firstTokenMs = Date.now() - this.turnStartedAt;
    }
    if (!this.tts) this.onStreamStart(messageId);
    const before = this.tts?.busy ?? false;
    this.tts?.push(text);
    // Mark when the first whole sentence became available, which is the start
    // of the "first sentence -> first audio chunk" budget.
    if (!before && this.tts?.busy && this.firstSentenceAt === 0) {
      this.firstSentenceAt = Date.now();
    }
  }

  /** The assistant message finished streaming. */
  onStreamEnd(messageId?: string): void {
    if (!this.active) return;
    // The end of a turn that has already been replaced, or of a foreign
    // (non-voice) turn: it has nothing to say and no latency of its own to
    // report. Matching on the id (rather than counting abandoned turns) means
    // this is correct regardless of which order the events actually arrive
    // in, which a simple counter could not guarantee.
    if (!this.isLiveTurn(messageId)) return;
    this.awaitingTurn = false;
    // A short reply ("Mango.") can end without ever completing a sentence
    // mid-stream, because the chunker waits for the character after the
    // terminator. The text is complete now, so this is when the "speakable
    // text exists" clock starts for that turn.
    if (this.firstSentenceAt === 0) this.firstSentenceAt = Date.now();
    if (!this.tts) {
      // Text streamed and finished, but no TtsStream was ever attached
      // (engine error path aside, this only happens if synthesis never
      // started at all). The text bubble already rendered through the normal
      // chat path; make sure the silence is at least explained in the log.
      if (this.turnHadText) this.warnIfTextWithoutAudio();
      this.setState("listening");
      return;
    }
    this.tts.end();
  }

  /** The turn failed before producing text. */
  onStreamError(messageId?: string): void {
    if (!this.active) return;
    // The abort we issued when replacing a turn can also surface as an error
    // rather than an end. Either way, if it is not the live turn it must not
    // cancel the live turn's TTS.
    if (!this.isLiveTurn(messageId)) return;
    this.awaitingTurn = false;
    if (this.turnHadText) this.warnIfTextWithoutAudio();
    this.tts?.cancel();
    this.tts = null;
    this.setState("listening");
  }

  /** True when the next `message:user` for this session came from the mic. */
  expectsVoiceTag(): boolean {
    return this.awaitingTurn;
  }

  // ---- outbound audio --------------------------------------------------

  private handleAudioChunk(chunk: AudioChunk, turnId: string): void {
    this.firstAudioEmitted = true;
    this.lastSpoken = chunk.text;
    this.deps.emit("voice:audio-chunk", {
      sessionId: this.sessionId,
      turnId,
      seq: chunk.seq,
      mime: chunk.mime,
      data: chunk.data,
    });
    if (!this.latencyReported) this.reportLatency();
  }

  /**
   * A turn produced text but the client never got a single audio chunk for
   * it (every sentence's synthesis failed, or none was ever attempted). The
   * text bubble already rendered through the normal chat path regardless of
   * voice, so nothing is visually blank, but the owner hears nothing and
   * without this line the Activity Log gives no reason why.
   */
  private warnIfTextWithoutAudio(): void {
    if (this.noAudioWarned || this.firstAudioEmitted) return;
    this.noAudioWarned = true;
    this.deps.activity(
      "voice: reply had text but no audio (speech synthesis failed); showing text only"
    );
  }

  /** Emit `voice:stop-audio` and drop everything queued for synthesis. */
  private stopSpeaking(): void {
    const wasSpeaking =
      this.speakingStartEmitted || Boolean(this.tts?.speaking) || this.state === "speaking";
    const turnId = this.turnId;
    // Stop the client's playback before anything else: that is the 100 ms the
    // user actually feels when they talk over her.
    if (wasSpeaking) this.deps.emit("voice:stop-audio", { sessionId: this.sessionId, turnId });
    const tts = this.tts;
    this.tts = null;
    tts?.cancel();
    if (this.speakingStartEmitted) {
      this.deps.emit("voice:speaking-end", { sessionId: this.sessionId, turnId });
      this.speakingStartEmitted = false;
    }
    // She is no longer speaking; keep the barge-in bar armed for the grace
    // window (her echo can linger in the room after playback stops) before
    // handing back to the plain VAD.
    this.bargeIn.deactivateAfterGrace();
  }

  private handleSpeakingEnd(turnId: string): void {
    if (this.speakingStartEmitted) {
      this.deps.emit("voice:speaking-end", { sessionId: this.sessionId, turnId });
      this.speakingStartEmitted = false;
    }
    this.bargeIn.deactivateAfterGrace();
    if (!this.latencyReported) this.reportLatency();
    if (this.turnHadText) this.warnIfTextWithoutAudio();
    this.tts = null;
    if (this.state !== "idle") this.setState("listening");
  }

  /** One `voice:latency` event plus one Activity Log line, once per turn. */
  private reportLatency(): void {
    if (this.latencyReported || this.turnStartedAt === 0) return;
    // A turn that never spoke has no "time to first word" to report. Without
    // this, an abandoned turn's cancelled TTS stream would fire the event with
    // empty timings and the real turn's numbers would then be suppressed.
    if (!this.firstAudioEmitted) return;
    this.latencyReported = true;
    const now = Date.now();
    const latency: VoiceLatency = {
      sttMs: this.sttMs,
      firstTokenMs: this.firstTokenMs,
      firstAudioMs:
        this.firstSentenceAt > 0 && this.firstAudioEmitted ? now - this.firstSentenceAt : 0,
      totalMs: this.speechEndedAt > 0 ? now - this.speechEndedAt : 0,
    };
    const warm = this.deps.warm?.() ?? false;
    this.deps.emit("voice:latency", {
      sessionId: this.sessionId,
      ...latency,
      warm,
      speculative: this.turnWasSpeculative,
    });
    // The engine label is what makes cold and warm turns comparable at a
    // glance in the Activity Log, which is the whole point of S16's first item.
    this.deps.activity(
      `voice: ${latency.totalMs} ms to first word ` +
        `(stt ${latency.sttMs} ms, first token ${latency.firstTokenMs} ms ` +
        `${warm ? "warm" : "cold"}${this.turnWasSpeculative ? ", speculative" : ""}, ` +
        `first audio ${latency.firstAudioMs} ms)`
    );
    this.logEvent("latency", { ...latency, warm, speculative: this.turnWasSpeculative });
  }

  // ---- state machine ---------------------------------------------------

  private setState(next: VoiceState): void {
    if (this.state === next) return;
    this.state = next;
    this.deps.emit("voice:state", { sessionId: this.sessionId, state: next });
    this.logEvent("state", { state: next });
  }
}
