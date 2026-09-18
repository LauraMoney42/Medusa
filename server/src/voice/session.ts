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
import { SttStream } from "./stt-stream.js";
import { TtsStream, type AudioChunk } from "./tts-stream.js";
import type { VadOptions } from "./vad.js";

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
}

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

  // ---- per-turn timing ----
  private speechEndedAt = 0;
  private sttMs = 0;
  private transcriptAt = 0;
  private firstTokenMs = 0;
  private firstSentenceAt = 0;
  private firstAudioEmitted = false;
  private latencyReported = false;

  /** True between "the user talked over the reply" and the re-prompt going out. */
  private bargingIn = false;
  /** Last sentence actually sent to the client; survives the TTS stream's death. */
  private lastSpoken = "";
  private speakingStartEmitted = false;
  /** Set while a voice-originated send is in flight, so the tap can tag it. */
  private awaitingTurn = false;

  constructor(deps: VoiceSessionDeps) {
    this.sessionId = deps.sessionId;
    this.deps = deps;
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

  // ---- lifecycle -------------------------------------------------------

  /** Voice mode on. Idempotent: a reconnecting client may call it again. */
  start(mode: VoiceMode = "always-on", vad?: VadOptions): void {
    this.mode = mode === "off" ? "always-on" : mode;
    if (!this.stt) {
      this.stt = new SttStream({
        provider: this.deps.stt,
        vad: vad ?? this.deps.vad,
        onSpeechStart: () => this.handleSpeechStart(),
        onSpeechEnd: (u) => {
          this.speechEndedAt = u.endedAt;
          this.setState("transcribing");
        },
        onTranscript: (text, meta) => this.handleTranscript(text, meta.sttMs),
        onError: (err) => {
          this.deps.activity(`voice: transcription failed: ${err.message}`);
          this.setState("listening");
        },
      });
    }
    this.setState("listening");
  }

  /** PCM16 frame from `voice:audio`. */
  pushAudio(chunk: Int16Array | ArrayBuffer | Buffer | Uint8Array): void {
    if (!this.stt || this.state === "idle") return;
    this.stt.pushAudio(chunk);
  }

  /** Voice mode off. Stops audio, drops the VAD buffer, releases the turn. */
  stop(): void {
    this.stt?.flush();
    this.stt?.close();
    this.stt = null;
    this.stopSpeaking();
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
    this.setState("listening");
  }

  dispose(): void {
    this.stt?.close();
    this.stt = null;
    this.tts?.cancel();
    this.tts = null;
    this.state = "idle";
  }

  // ---- inbound audio ---------------------------------------------------

  /**
   * The VAD gate opened. Speech while she is talking is the fast half of
   * barge-in: audio stops now (about 100 ms), and the abort plus re-prompt
   * follow once the transcript lands.
   */
  private handleSpeechStart(): void {
    if (this.state === "speaking" || this.tts?.speaking) {
      this.bargingIn = true;
      this.stopSpeaking();
      this.deps.activity("voice: barge-in, stopped playback");
    }
  }

  private handleTranscript(text: string, sttMs: number): void {
    this.sttMs = sttMs;
    this.transcriptAt = Date.now();
    const messageId = randomUUID();
    this.deps.emit("voice:transcript", { sessionId: this.sessionId, text, messageId });

    // A transcript that arrives while she is still talking is a barge-in even
    // if the VAD gate opened before playback started.
    const interrupting = this.bargingIn || this.state === "speaking";
    let prompt = text;

    if (interrupting) {
      const lastSpoken = this.tts?.lastSpokenSentence || this.lastSpoken;
      this.stopSpeaking();
      if (this.deps.isBusy()) {
        this.deps.abortTurn();
        this.deps.activity(`voice: aborted turn for barge-in after "${lastSpoken}"`);
      }
      if (lastSpoken) prompt = `${interruptionPrefix(lastSpoken)}${text}`;
    }
    this.bargingIn = false;

    // New turn: reset the stage clocks before anything can tick.
    this.firstTokenMs = 0;
    this.firstSentenceAt = 0;
    this.firstAudioEmitted = false;
    this.latencyReported = false;
    this.speakingStartEmitted = false;
    this.awaitingTurn = true;

    this.setState("thinking");
    this.deps.send(prompt);
  }

  // ---- assistant stream tap -------------------------------------------

  /** A new assistant message started streaming for this session. */
  onStreamStart(): void {
    if (!this.active) return;
    this.awaitingTurn = false;
    this.tts?.cancel();
    this.tts = new TtsStream({
      synthesize: (t, v) => this.deps.tts.synthesize(t, v),
      voice: this.deps.voice,
      lookahead: 1,
      onChunk: (chunk) => this.handleAudioChunk(chunk),
      onStart: () => {
        this.speakingStartEmitted = true;
        this.setState("speaking");
        this.deps.emit("voice:speaking-start", { sessionId: this.sessionId });
      },
      onEnd: () => this.handleSpeakingEnd(),
      onError: (err) => this.deps.activity(`voice: synthesis failed: ${err.message}`),
    });
    this.setState("thinking");
  }

  /** One assistant text delta. */
  onDelta(text: string): void {
    if (!this.active || !text) return;
    if (this.firstTokenMs === 0 && this.transcriptAt > 0) {
      this.firstTokenMs = Date.now() - this.transcriptAt;
    }
    if (!this.tts) this.onStreamStart();
    const before = this.tts?.busy ?? false;
    this.tts?.push(text);
    // Mark when the first whole sentence became available, which is the start
    // of the "first sentence -> first audio chunk" budget.
    if (!before && this.tts?.busy && this.firstSentenceAt === 0) {
      this.firstSentenceAt = Date.now();
    }
  }

  /** The assistant message finished streaming. */
  onStreamEnd(): void {
    if (!this.active) return;
    this.awaitingTurn = false;
    if (!this.tts) {
      this.setState("listening");
      return;
    }
    this.tts.end();
  }

  /** The turn failed before producing text. */
  onStreamError(): void {
    if (!this.active) return;
    this.awaitingTurn = false;
    this.tts?.cancel();
    this.tts = null;
    this.setState("listening");
  }

  /** True when the next `message:user` for this session came from the mic. */
  expectsVoiceTag(): boolean {
    return this.awaitingTurn;
  }

  // ---- outbound audio --------------------------------------------------

  private handleAudioChunk(chunk: AudioChunk): void {
    this.firstAudioEmitted = true;
    this.lastSpoken = chunk.text;
    this.deps.emit("voice:audio-chunk", {
      sessionId: this.sessionId,
      seq: chunk.seq,
      mime: chunk.mime,
      data: chunk.data,
    });
    if (!this.latencyReported) this.reportLatency();
  }

  /** Emit `voice:stop-audio` and drop everything queued for synthesis. */
  private stopSpeaking(): void {
    const wasSpeaking =
      this.speakingStartEmitted || Boolean(this.tts?.speaking) || this.state === "speaking";
    // Stop the client's playback before anything else: that is the 100 ms the
    // user actually feels when they talk over her.
    if (wasSpeaking) this.deps.emit("voice:stop-audio", { sessionId: this.sessionId });
    const tts = this.tts;
    this.tts = null;
    tts?.cancel();
    if (this.speakingStartEmitted) {
      this.deps.emit("voice:speaking-end", { sessionId: this.sessionId });
      this.speakingStartEmitted = false;
    }
  }

  private handleSpeakingEnd(): void {
    if (this.speakingStartEmitted) {
      this.deps.emit("voice:speaking-end", { sessionId: this.sessionId });
      this.speakingStartEmitted = false;
    }
    if (!this.latencyReported) this.reportLatency();
    this.tts = null;
    if (this.state !== "idle") this.setState("listening");
  }

  /** One `voice:latency` event plus one Activity Log line, once per turn. */
  private reportLatency(): void {
    if (this.latencyReported || this.transcriptAt === 0) return;
    this.latencyReported = true;
    const now = Date.now();
    const latency: VoiceLatency = {
      sttMs: this.sttMs,
      firstTokenMs: this.firstTokenMs,
      firstAudioMs:
        this.firstSentenceAt > 0 && this.firstAudioEmitted ? now - this.firstSentenceAt : 0,
      totalMs: this.speechEndedAt > 0 ? now - this.speechEndedAt : 0,
    };
    this.deps.emit("voice:latency", { sessionId: this.sessionId, ...latency });
    this.deps.activity(
      `voice: ${latency.totalMs} ms to first word ` +
        `(stt ${latency.sttMs} ms, first token ${latency.firstTokenMs} ms, ` +
        `first audio ${latency.firstAudioMs} ms)`
    );
  }

  // ---- state machine ---------------------------------------------------

  private setState(next: VoiceState): void {
    if (this.state === next) return;
    this.state = next;
    this.deps.emit("voice:state", { sessionId: this.sessionId, state: next });
  }
}
