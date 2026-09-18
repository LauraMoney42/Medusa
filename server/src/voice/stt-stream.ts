/**
 * Microphone PCM in, transcripts out.
 *
 * Owns a `Vad` and an `SttProvider`: frames arrive from the socket, the VAD
 * decides where the utterance ends, and the utterance is handed straight to
 * Whisper. Transcription is serialized per session so a fast second utterance
 * can never overtake a slow first one in the conversation.
 */

import type { SttProvider } from "./providers.js";
import { Vad, type VadOptions, type VadUtterance } from "./vad.js";

export interface SttStreamCallbacks {
  /** Gate opened. Used for the fast half of barge-in, before any text exists. */
  onSpeechStart?: () => void;
  /** Silence ended an utterance; transcription has been dispatched. */
  onSpeechEnd?: (utterance: VadUtterance) => void;
  /** Final text for one utterance, with the Whisper round-trip time. */
  onTranscript?: (text: string, meta: { sttMs: number; endedAt: number; durationMs: number }) => void;
  onError?: (err: Error) => void;
}

export interface SttStreamOptions extends SttStreamCallbacks {
  provider: SttProvider;
  vad?: VadOptions;
}

export class SttStream {
  readonly vad: Vad;

  private readonly provider: SttProvider;
  private readonly cb: SttStreamCallbacks;
  /** Tail of the transcription chain; keeps utterances strictly in order. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: SttStreamOptions) {
    this.provider = opts.provider;
    this.cb = opts;
    this.vad = new Vad(opts.vad);
    this.vad.onSpeechStart = () => this.cb.onSpeechStart?.();
  }

  /** Feed one socket frame. Accepts PCM16 in any of the shapes socket.io gives. */
  pushAudio(chunk: Int16Array | ArrayBuffer | Buffer | Uint8Array): void {
    if (this.closed) return;
    const pcm = toPcm16(chunk);
    if (pcm.length === 0) return;
    for (const utterance of this.vad.push(pcm)) this.dispatch(utterance);
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
    this.vad.reset();
  }

  private dispatch(utterance: VadUtterance): void {
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
