/**
 * Assistant text stream in, ordered audio chunks out.
 *
 * Deltas are sentence-chunked (see `sentence-chunker.ts`) and synthesized with
 * a lookahead of one: two Kokoro requests may be in flight at a time, so the
 * next sentence is already rendering while the current one plays, but chunks
 * are always emitted in the order the sentences were written. A slow synth on
 * sentence 1 therefore delays sentence 2 rather than letting it jump the queue.
 *
 * `cancel()` is the barge-in path: the queue is dropped and any in-flight
 * synthesis result is discarded instead of emitted.
 */

import { SentenceChunker, speakableText } from "./sentence-chunker.js";

export interface AudioChunk {
  /** Monotonic per-turn index. The client plays chunks in this order. */
  seq: number;
  mime: string;
  /** base64-encoded audio (WAV from Kokoro). */
  data: string;
  /** The sentence this chunk speaks, so barge-in can quote it. */
  text: string;
}

export interface TtsStreamOptions {
  synthesize(text: string, voice?: string): Promise<{ audio: Buffer; mime: string }>;
  voice?: string;
  /** Sentences allowed to render ahead of the one being emitted. */
  lookahead?: number;
  onChunk(chunk: AudioChunk): void;
  /** Fired once, just before the first chunk of a turn. */
  onStart?: () => void;
  /** Fired once every queued sentence has been emitted after `end()`. */
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

interface InFlight {
  seq: number;
  text: string;
  promise: Promise<{ audio: Buffer; mime: string }>;
}

export class TtsStream {
  private readonly chunker = new SentenceChunker();
  private readonly queue: string[] = [];
  private readonly inflight: InFlight[] = [];
  private readonly lookahead: number;

  private nextSeq = 0;
  /** Unterminated tail of the current line, for the markdown gate. */
  private lineBuf = "";
  /** How much of `lineBuf` has already gone to the chunker. */
  private forwarded = 0;
  private inFence = false;
  private draining = false;
  private inputEnded = false;
  private cancelled = false;
  private started = false;
  private ended = false;

  /** The most recent sentence actually sent to the client, for the barge-in prefix. */
  lastSpokenSentence = "";

  constructor(private readonly opts: TtsStreamOptions) {
    this.lookahead = Math.max(0, opts.lookahead ?? 1);
  }

  /** True while sentences are queued or rendering. */
  get busy(): boolean {
    return this.queue.length > 0 || this.inflight.length > 0;
  }

  /** True once at least one audio chunk has gone out for this turn. */
  get speaking(): boolean {
    return this.started && !this.ended;
  }

  /** Feed one assistant delta. */
  push(delta: string): void {
    if (this.cancelled || this.inputEnded) return;
    this.filter(delta);
    void this.drain();
  }

  /** The assistant turn finished; speak the remainder and then report end. */
  end(): void {
    if (this.cancelled || this.inputEnded) return;
    this.inputEnded = true;
    // Whatever is left of the final, unterminated line.
    if (!this.inFence && this.lineBuf.slice(this.forwarded)) {
      this.feed(this.lineBuf.slice(this.forwarded));
    }
    this.lineBuf = "";
    this.forwarded = 0;
    for (const sentence of this.chunker.flush()) this.enqueue(sentence);
    void this.drain();
  }

  /**
   * Line-oriented markdown gate, run before sentence chunking.
   *
   * Fenced code and table rows only become recognisable once their line is
   * complete, so a partial line is held back whenever it could still turn into
   * one (it contains a backtick, or starts with a pipe). Everything else is
   * forwarded the instant it arrives, which is what keeps the first sentence
   * fast.
   */
  private filter(delta: string): void {
    this.lineBuf += delta;
    for (;;) {
      const nl = this.lineBuf.indexOf("\n");
      if (nl < 0) break;
      const line = this.lineBuf.slice(0, nl + 1);
      this.lineBuf = this.lineBuf.slice(nl + 1);
      const already = Math.min(this.forwarded, line.length);
      this.forwarded = 0;

      const trimmed = line.trim();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        this.inFence = !this.inFence;
        continue;
      }
      if (this.inFence) continue;
      if (trimmed.startsWith("|")) continue; // table row: shown, never spoken
      const fresh = line.slice(already);
      if (fresh) this.feed(fresh);
    }

    if (this.inFence) {
      this.forwarded = this.lineBuf.length;
      return;
    }
    const tail = this.lineBuf;
    if (tail.includes("`") || tail.includes("~~") || tail.trimStart().startsWith("|")) return;
    const fresh = tail.slice(this.forwarded);
    if (fresh) {
      this.forwarded = tail.length;
      this.feed(fresh);
    }
  }

  private feed(text: string): void {
    for (const sentence of this.chunker.push(text)) this.enqueue(sentence);
  }

  /**
   * Barge-in: stop speaking immediately. Queued sentences are dropped and any
   * in-flight synthesis resolves into the void.
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.queue.length = 0;
    this.inflight.length = 0;
    this.chunker.reset();
    this.lineBuf = "";
    this.forwarded = 0;
    if (this.started && !this.ended) {
      this.ended = true;
      this.opts.onEnd?.();
    }
  }

  private enqueue(raw: string): void {
    const text = speakableText(raw).trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
    this.queue.push(text);
  }

  /** Keep `1 + lookahead` synthesis requests in flight. */
  private fill(): void {
    while (!this.cancelled && this.inflight.length <= this.lookahead && this.queue.length > 0) {
      const text = this.queue.shift() as string;
      const seq = this.nextSeq++;
      this.inflight.push({
        seq,
        text,
        promise: this.opts.synthesize(text, this.opts.voice),
      });
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        this.fill();
        const head = this.inflight[0];
        if (!head) break;
        let result: { audio: Buffer; mime: string } | null = null;
        try {
          result = await head.promise;
        } catch (err) {
          this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
        // cancel() emptied the array while we awaited: this chunk is stale.
        if (this.cancelled || this.inflight[0] !== head) break;
        this.inflight.shift();
        if (!result) continue;
        if (!this.started) {
          this.started = true;
          this.opts.onStart?.();
        }
        this.lastSpokenSentence = head.text;
        this.opts.onChunk({
          seq: head.seq,
          mime: result.mime,
          data: result.audio.toString("base64"),
          text: head.text,
        });
      }
    } finally {
      this.draining = false;
    }

    if (!this.cancelled && this.inputEnded && !this.busy && !this.ended) {
      this.ended = true;
      this.opts.onEnd?.();
    }
  }
}
