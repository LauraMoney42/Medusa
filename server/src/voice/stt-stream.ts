/**
 * Microphone PCM in, transcripts out.
 *
 * Owns a `Vad` and an `SttProvider`: frames arrive from the socket, the VAD
 * decides where the utterance ends, and the utterance is handed straight to
 * Whisper. Transcription is serialized per session so a fast second utterance
 * can never overtake a slow first one in the conversation.
 */

import type { SttProvider } from "./providers.js";
import type { StreamingSttProvider, StreamingSttSession } from "./streaming-stt.js";
import { RollingWindowSttSession } from "./streaming-stt.js";
import { Vad, type VadOptions, type VadUtterance } from "./vad.js";

export interface SttStreamCallbacks {
  /** Gate opened. Used for the fast half of barge-in, before any text exists. */
  onSpeechStart?: () => void;
  /**
   * A growing hypothesis for the utterance in progress (S16). Emitted as
   * `voice:partial`; never a turn on its own, though the speculative start
   * in `session.ts` reads it.
   */
  onPartial?: (text: string) => void;
  /** Silence ended an utterance; transcription has been dispatched. */
  onSpeechEnd?: (utterance: VadUtterance) => void;
  /** Final text for one utterance, with the Whisper round-trip time. */
  onTranscript?: (text: string, meta: { sttMs: number; endedAt: number; durationMs: number }) => void;
  onError?: (err: Error) => void;
}

export interface SttStreamOptions extends SttStreamCallbacks {
  provider: SttProvider;
  vad?: VadOptions;
  /**
   * Partial-hypothesis source (S16). Omit it and the stream behaves exactly
   * as it did in S14: silence until the final transcript.
   */
  partials?: StreamingSttProvider | null;
}

export class SttStream {
  readonly vad: Vad;

  private readonly provider: SttProvider;
  private readonly cb: SttStreamCallbacks;
  private readonly partialProvider: StreamingSttProvider | null;
  private partialSession: StreamingSttSession | null = null;
  /** Tail of the transcription chain; keeps utterances strictly in order. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  /** Most recent partial for the utterance in progress. */
  lastPartial = "";

  constructor(opts: SttStreamOptions) {
    this.provider = opts.provider;
    this.cb = opts;
    this.partialProvider = opts.partials ?? null;
    this.vad = new Vad(opts.vad);
    this.vad.onSpeechStart = () => {
      this.openPartials();
      this.cb.onSpeechStart?.();
    };
  }

  /** Feed one socket frame. Accepts PCM16 in any of the shapes socket.io gives. */
  pushAudio(chunk: Int16Array | ArrayBuffer | Buffer | Uint8Array): void {
    if (this.closed) return;
    const pcm = toPcm16(chunk);
    if (pcm.length === 0) return;
    const utterances = this.vad.push(pcm);
    // Partials run off the VAD's own buffer so the window the hypothesis sees
    // is exactly the audio the final transcription will see.
    if (this.partialSession && this.vad.speaking) {
      if (this.partialSession instanceof RollingWindowSttSession) {
        const snapshot = this.vad.snapshot();
        if (snapshot) this.partialSession.setBuffer(snapshot);
      } else {
        this.partialSession.push(pcm);
      }
    }
    for (const utterance of utterances) this.dispatch(utterance);
  }

  /** Open a partial session for the utterance that just started. */
  private openPartials(): void {
    if (!this.partialProvider || this.partialSession) return;
    this.lastPartial = "";
    this.partialSession = this.partialProvider.open({
      onPartial: (text) => {
        if (this.closed) return;
        this.lastPartial = text;
        this.cb.onPartial?.(text);
      },
      onError: (err) => this.cb.onError?.(err),
    });
  }

  /** Close the partial session at the end of an utterance. */
  private closePartials(): void {
    this.partialSession?.close();
    this.partialSession = null;
    this.lastPartial = "";
  }

  /** End the open utterance now (push-to-talk release, or session stop). */
  flush(): void {
    if (this.closed) return;
    const utterance = this.vad.flush();
    if (utterance) this.dispatch(utterance);
  }

  /** Stop accepting audio. In-flight transcriptions still resolve. */
  close(): void {
    this.closed = true;
    this.closePartials();
    this.vad.reset();
  }

  private dispatch(utterance: VadUtterance): void {
    this.closePartials();
    this.cb.onSpeechEnd?.(utterance);
    this.chain = this.chain.then(async () => {
      const started = Date.now();
      try {
        const text = await this.provider.transcribe(
          utterance.pcm,
          this.vad.options.sampleRate
        );
        if (this.closed) return;
        const clean = text.trim();
        // Whisper emits "[BLANK_AUDIO]", "(silence)" and bare punctuation on
        // near-empty input. None of that should become a turn.
        if (!clean || !/[\p{L}\p{N}]/u.test(clean) || /^[[(].*[\])]$/.test(clean)) return;
        this.cb.onTranscript?.(clean, {
          sttMs: Date.now() - started,
          endedAt: utterance.endedAt,
          durationMs: utterance.durationMs,
        });
      } catch (err) {
        this.cb.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

/** Normalize whatever the socket delivered into little-endian PCM16 samples. */
export function toPcm16(chunk: Int16Array | ArrayBuffer | Buffer | Uint8Array): Int16Array {
  if (chunk instanceof Int16Array) return chunk;
  if (chunk instanceof ArrayBuffer) {
    return new Int16Array(chunk, 0, Math.floor(chunk.byteLength / 2));
  }
  const view = chunk as Uint8Array;
  if (!view || typeof view.byteLength !== "number") return new Int16Array(0);
  const count = Math.floor(view.byteLength / 2);
  // byteOffset may be non-zero (Buffer slices share a pooled ArrayBuffer), and
  // it is not guaranteed to be 2-byte aligned, so copy rather than view.
  const out = new Int16Array(count);
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i < count; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}
