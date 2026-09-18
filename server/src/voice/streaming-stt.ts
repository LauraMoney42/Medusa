/**
 * Streaming speech-to-text (S16).
 *
 * S14 shipped one-shot transcription: the VAD decides an utterance is over and
 * the whole thing goes to Whisper at once. That is accurate and cheap, but the
 * screen shows nothing at all while you are talking, and nothing downstream can
 * start working before you stop.
 *
 * `StreamingSttProvider` is the interface that fixes both: push PCM, get
 * `partial` events as the hypothesis grows and one `final` when the utterance
 * closes. Two implementations ship:
 *
 *  - `RollingWindowSttProvider` (default, local): the running Whisper server at
 *    `STT_API_BASE_URL` exposes exactly two routes, `/v1/models` and
 *    `/v1/audio/transcriptions` (verified against its own OpenAPI document on
 *    2026-09-18), so there is no streaming endpoint to call. Instead the
 *    utterance so far is re-transcribed on a fixed cadence (700 ms by default).
 *    The cost is bounded three ways: one request in flight at a time, no
 *    partials once the utterance passes 15 s, and no partial for audio shorter
 *    than a third of a second.
 *  - `DeepgramStreamingSttProvider` (optional, off by default): a genuine
 *    streaming socket, behind the same interface, keyed from the providers
 *    settings.
 *
 * Nothing here touches the socket layer: `stt-stream.ts` owns that and simply
 * forwards `partial` events as `voice:partial`.
 */

import type { SttProvider } from "./providers.js";

export interface SttStreamHandlers {
  /** A growing hypothesis for the utterance in progress. */
  onPartial?: (text: string) => void;
  /** The settled text for the utterance. */
  onFinal?: (text: string) => void;
  onError?: (err: Error) => void;
}

/** One open utterance. Providers own whatever connection state they need. */
export interface StreamingSttSession {
  /** Feed PCM16 as it arrives. */
  push(pcm: Int16Array): void;
  /** No more audio: settle the final text. */
  end(): void;
  /** Give up on this utterance (barge-in, session stop). */
  close(): void;
}

export interface StreamingSttProvider {
  readonly id: string;
  /** False for a provider that can only produce the final text. */
  readonly supportsPartials: boolean;
  isReady(): boolean;
  open(handlers: SttStreamHandlers): StreamingSttSession;
}

export interface RollingWindowOptions {
  /** How often to re-transcribe the utterance so far. */
  intervalMs?: number;
  /** Stop producing partials once the utterance is this long. */
  maxUtteranceMs?: number;
  /** Do not bother transcribing less audio than this. */
  minAudioMs?: number;
  sampleRate?: number;
  /** Injectable clock, so the tests do not sleep. */
  now?: () => number;
}

export const ROLLING_DEFAULTS: Required<Omit<RollingWindowOptions, "now">> = {
  intervalMs: 700,
  maxUtteranceMs: 15_000,
  minAudioMs: 300,
  sampleRate: 16_000,
};

/**
 * Partial transcription by re-running the one-shot provider on a rolling
 * window of the current utterance.
 *
 * Driven entirely by `push()`: audio frames arrive about every 100 ms from the
 * client, so there is no timer to leak and a test can advance a fake clock and
 * push synthetic PCM to get deterministic timing.
 */
export class RollingWindowSttSession implements StreamingSttSession {
  private readonly opts: Required<Omit<RollingWindowOptions, "now">>;
  private readonly now: () => number;
  private readonly chunks: Int16Array[] = [];
  private samples = 0;
  private started = false;
  private startedAt = 0;
  private lastRunAt = 0;
  private inFlight = false;
  private closed = false;
  private lastText = "";
  /** Partial count, for the Activity Log line and the tests. */
  partialCount = 0;

  constructor(
    private readonly provider: SttProvider,
    private readonly handlers: SttStreamHandlers,
    options: RollingWindowOptions = {}
  ) {
    this.opts = { ...ROLLING_DEFAULTS, ...options };
    this.now = options.now ?? Date.now;
  }

  /** Milliseconds of audio buffered so far. */
  get bufferedMs(): number {
    return (this.samples / this.opts.sampleRate) * 1000;
  }

  push(pcm: Int16Array): void {
    if (this.closed || pcm.length === 0) return;
    const at = this.now();
    // A boolean rather than `startedAt === 0`, so an injected clock that
    // starts at zero still marks the utterance as begun.
    if (!this.started) {
      this.started = true;
      this.startedAt = at;
      this.lastRunAt = at;
    }
    this.chunks.push(pcm);
    this.samples += pcm.length;
    this.maybeRun(at);
  }

  /**
   * Replace the buffer with the authoritative audio for the utterance so far.
   * `stt-stream.ts` uses this: the VAD already holds the segmented audio
   * (pre-roll included), so there is no reason to keep a second copy in step.
   */
  setBuffer(pcm: Int16Array): void {
    if (this.closed) return;
    const at = this.now();
    // A boolean rather than `startedAt === 0`, so an injected clock that
    // starts at zero still marks the utterance as begun.
    if (!this.started) {
      this.started = true;
      this.startedAt = at;
      this.lastRunAt = at;
    }
    this.chunks.length = 0;
    this.chunks.push(pcm);
    this.samples = pcm.length;
    this.maybeRun(at);
  }

  end(): void {
    // The final text comes from the caller's own one-shot transcription of the
    // complete utterance, which is strictly more accurate than any window.
    this.close();
  }

  close(): void {
    this.closed = true;
    this.chunks.length = 0;
    this.samples = 0;
  }

  private maybeRun(at: number): void {
    if (this.inFlight) return;
    if (at - this.lastRunAt < this.opts.intervalMs) return;
    if (this.bufferedMs < this.opts.minAudioMs) return;
    // Past the cap a long monologue would cost one full transcription per
    // interval for no benefit, so partials simply stop.
    if (at - this.startedAt > this.opts.maxUtteranceMs) return;

    this.lastRunAt = at;
    this.inFlight = true;
    const pcm = this.join();
    void this.provider
      .transcribe(pcm, this.opts.sampleRate)
      .then((text) => {
        if (this.closed) return;
        const clean = text.trim();
        if (!clean || clean === this.lastText) return;
        if (!/[\p{L}\p{N}]/u.test(clean)) return;
        this.lastText = clean;
        this.partialCount++;
        this.handlers.onPartial?.(clean);
      })
      .catch((err: unknown) => {
        // A failed partial is not a failed turn: the final transcription is
        // what the conversation actually runs on.
        this.handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  private join(): Int16Array {
    if (this.chunks.length === 1) return this.chunks[0] as Int16Array;
    const out = new Int16Array(this.samples);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/** The local, no-extra-dependencies partial provider. */
export class RollingWindowSttProvider implements StreamingSttProvider {
  readonly id: string;
  readonly supportsPartials = true;

  constructor(
    private readonly provider: SttProvider,
    private readonly options: RollingWindowOptions = {}
  ) {
    this.id = `${provider.id}-rolling`;
  }

  isReady(): boolean {
    return this.provider.isReady();
  }

  open(handlers: SttStreamHandlers): RollingWindowSttSession {
    return new RollingWindowSttSession(this.provider, handlers, this.options);
  }
}

// ---- Optional cloud provider ------------------------------------------

/** The slice of the WebSocket API this module needs; keeps tests dependency-free. */
export interface MinimalWebSocket {
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  readyState: number;
}

export type WebSocketFactory = (url: string, protocols?: string[]) => MinimalWebSocket;

export interface DeepgramOptions {
  apiKey: string;
  sampleRate?: number;
  model?: string;
  /** Defaults to the global WebSocket (Node 22 ships one). */
  createSocket?: WebSocketFactory;
}

/**
 * Deepgram's live transcription socket, behind `StreamingSttProvider`.
 *
 * Off by default and only reachable when a key exists in the providers
 * settings (`providers.deepgram.apiKey`) or `DEEPGRAM_API_KEY`. Auth uses the
 * documented `token` subprotocol rather than a header, because the WebSocket
 * built into Node accepts subprotocols but not custom headers.
 */
export class DeepgramStreamingSttProvider implements StreamingSttProvider {
  readonly id = "deepgram";
  readonly supportsPartials = true;

  constructor(private readonly options: DeepgramOptions) {}

  isReady(): boolean {
    return Boolean(this.options.apiKey);
  }

  open(handlers: SttStreamHandlers): StreamingSttSession {
    const sampleRate = this.options.sampleRate ?? 16_000;
    const params = new URLSearchParams({
      encoding: "linear16",
      sample_rate: String(sampleRate),
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      model: this.options.model ?? "nova-2",
    });
    const create =
      this.options.createSocket ??
      ((url: string, protocols?: string[]) =>
        new (globalThis as any).WebSocket(url, protocols) as MinimalWebSocket);

    const socket = create(`wss://api.deepgram.com/v1/listen?${params.toString()}`, [
      "token",
      this.options.apiKey,
    ]);

    let open = false;
    const backlog: Int16Array[] = [];
    let finalText = "";

    socket.addEventListener("open", () => {
      open = true;
      for (const pcm of backlog.splice(0)) socket.send(toBytes(pcm));
    });
    socket.addEventListener("error", () => {
      handlers.onError?.(new Error("Deepgram socket error"));
    });
    socket.addEventListener("message", (event: { data?: unknown }) => {
      let payload: any;
      try {
        payload = JSON.parse(String(event.data ?? ""));
      } catch {
        return;
      }
      const text: string = payload?.channel?.alternatives?.[0]?.transcript ?? "";
      if (!text) return;
      if (payload.is_final || payload.speech_final) {
        finalText = finalText ? `${finalText} ${text}` : text;
        handlers.onPartial?.(finalText);
      } else {
        handlers.onPartial?.(finalText ? `${finalText} ${text}` : text);
      }
    });

    return {
      push: (pcm: Int16Array) => {
        if (!open) backlog.push(pcm);
        else socket.send(toBytes(pcm));
      },
      end: () => {
        try {
          socket.send(JSON.stringify({ type: "CloseStream" }));
        } catch {
          // Socket already gone.
        }
        if (finalText) handlers.onFinal?.(finalText);
      },
      close: () => {
        try {
          socket.close();
        } catch {
          // Already closed.
        }
      },
    };
  }
}

function toBytes(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}
