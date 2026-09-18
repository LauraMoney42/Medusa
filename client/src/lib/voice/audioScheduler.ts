/**
 * Gapless playback scheduler for `voice:audio-chunk` frames (spec section 4,
 * 7). TTS sentences arrive over the socket in order but on their own timers
 * (Kokoro synthesis time varies per sentence), each tagged with a `seq`. This
 * schedules each decoded buffer to start exactly when the previous one ends,
 * using AudioBufferSourceNode's own start-time scheduling rather than
 * back-to-back `play()` calls, which would leave audible gaps.
 *
 * Only the scheduling math is exercised by a plain interface
 * (`MinimalAudioContext`) so it can be unit tested without a real
 * AudioContext/jsdom; `VoiceBar` wires it to a real one.
 */

export interface MinimalAudioBuffer {
  readonly duration: number;
}

export interface MinimalSourceNode {
  buffer: MinimalAudioBuffer | null;
  // Typed with an Event param (unused by our own callbacks) so a real
  // AudioBufferSourceNode's `onended: (ev: Event) => any` is structurally
  // assignable here; a plain `() => void` handler is still fine to assign
  // since JS (and TS) callbacks may ignore extra arguments.
  onended: ((ev: Event) => void) | null;
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface MinimalAudioContext {
  readonly currentTime: number;
  readonly destination: unknown;
  createBufferSource(): MinimalSourceNode;
}

interface QueuedChunk {
  seq: number;
  buffer: MinimalAudioBuffer;
}

/**
 * Buffers audio chunks that may arrive out of order (spec section 7 does not
 * guarantee `voice:audio-chunk` delivery order under concurrent sentence
 * synthesis) and schedules only a contiguous run starting at the next
 * expected seq, back to back with no gap.
 */
export class GaplessAudioQueue {
  private ctx: MinimalAudioContext;
  private destination: unknown;
  private nextExpectedSeq = 0;
  private nextStartTime = 0;
  private pending = new Map<number, QueuedChunk>();
  private activeSources: MinimalSourceNode[] = [];
  private muted = false;
  /** Called once with the seq of every chunk as it actually starts playing. */
  onChunkStart: ((seq: number) => void) | null = null;
  /** Called when the last scheduled chunk finishes and the queue goes idle. */
  onDrain: (() => void) | null = null;

  constructor(ctx: MinimalAudioContext, destination?: unknown) {
    this.ctx = ctx;
    this.destination = destination ?? ctx.destination;
  }

  get muted_(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** Reset sequence tracking for a new utterance/turn without touching audio. */
  resetSequence(): void {
    this.nextExpectedSeq = 0;
    this.pending.clear();
  }

  /** Enqueue a decoded chunk. Schedules it (and any now-contiguous successors). */
  enqueue(seq: number, buffer: MinimalAudioBuffer): void {
    if (seq < this.nextExpectedSeq) return; // stale/duplicate, e.g. after a stop
    this.pending.set(seq, { seq, buffer });
    this.drainContiguous();
  }

  private drainContiguous(): void {
    for (;;) {
      const next = this.pending.get(this.nextExpectedSeq);
      if (!next) return;
      this.pending.delete(this.nextExpectedSeq);
      this.scheduleOne(next.buffer, next.seq);
      this.nextExpectedSeq += 1;
    }
  }

  private scheduleOne(buffer: MinimalAudioBuffer, seq: number): void {
    const startAt = Math.max(this.ctx.currentTime, this.nextStartTime);
    if (!this.muted) {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.destination);
      source.onended = () => {
        this.activeSources = this.activeSources.filter((s) => s !== source);
        if (this.activeSources.length === 0 && this.pending.size === 0) {
          this.onDrain?.();
        }
      };
      source.start(startAt);
      this.activeSources.push(source);
    }
    this.onChunkStart?.(seq);
    this.nextStartTime = startAt + buffer.duration;
  }

  /** `voice:stop-audio`: stop everything immediately and forget queued chunks. */
  stopAll(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Already stopped/ended; nothing to do.
      }
    }
    this.activeSources = [];
    this.pending.clear();
    this.nextStartTime = this.ctx.currentTime;
    this.nextExpectedSeq = 0;
  }

  /** For tests/UI: the time the next-scheduled chunk would start playing. */
  peekNextStartTime(): number {
    return this.nextStartTime;
  }
}
