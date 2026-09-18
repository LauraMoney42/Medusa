/**
 * Voice activity detection over 16 kHz mono PCM16.
 *
 * Deliberately an energy gate rather than a neural VAD: it has to run on every
 * 100 ms frame of every open voice session with no model load and no GPU, and
 * the only decision it makes is "has the user stopped talking". A short
 * hangover (default 600 ms of sub-threshold frames) ends an utterance, and a
 * pre-roll buffer is prepended so the first consonant is not clipped off the
 * front of the audio we hand to Whisper.
 *
 * Everything here is pure arithmetic on Int16Array, which is what makes the
 * segmentation testable on synthetic PCM without any audio stack.
 */

export interface VadOptions {
  /** Samples per second. The client downsamples to 16 kHz before sending. */
  sampleRate?: number;
  /** Analysis frame size. 20 ms at 16 kHz is 320 samples. */
  frameMs?: number;
  /** RMS gate, in int16 units (0..32767). Roughly -36 dBFS at 500. */
  energyThreshold?: number;
  /** Sub-threshold time that ends an utterance. */
  silenceMs?: number;
  /** Utterances shorter than this are discarded as coughs/clicks. */
  minSpeechMs?: number;
  /** Audio kept before the first speech frame, so onsets survive. */
  preRollMs?: number;
  /** Hard cap: a monologue is cut here so Whisper still gets fed. */
  maxUtteranceMs?: number;
}

export interface ResolvedVadOptions extends Required<VadOptions> {}

export const VAD_DEFAULTS: ResolvedVadOptions = {
  sampleRate: 16_000,
  frameMs: 20,
  energyThreshold: 500,
  silenceMs: 600,
  minSpeechMs: 200,
  preRollMs: 300,
  maxUtteranceMs: 30_000,
};

/** Resolve partial options against the defaults, clamping the silly values. */
export function resolveVadOptions(opts?: VadOptions): ResolvedVadOptions {
  const merged = { ...VAD_DEFAULTS, ...(opts ?? {}) };
  return {
    ...merged,
    sampleRate: Math.max(8000, merged.sampleRate),
    frameMs: Math.max(10, merged.frameMs),
    energyThreshold: Math.max(1, merged.energyThreshold),
    silenceMs: Math.max(100, merged.silenceMs),
    minSpeechMs: Math.max(0, merged.minSpeechMs),
    preRollMs: Math.max(0, merged.preRollMs),
    maxUtteranceMs: Math.max(1000, merged.maxUtteranceMs),
  };
}

/** Root-mean-square amplitude of one frame, in int16 units. */
export function frameEnergy(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] as number;
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

/** One segmented utterance, with the wall-clock moment speech stopped. */
export interface VadUtterance {
  pcm: Int16Array;
  /** Duration of the segmented audio, pre-roll included. */
  durationMs: number;
  /** `Date.now()` when the silence hangover completed. */
  endedAt: number;
  /** True when the hard `maxUtteranceMs` cap cut this one, not silence. */
  truncated: boolean;
}

/**
 * Streaming segmenter. Feed it PCM as it arrives; it hands back whole
 * utterances once each one's trailing silence has elapsed.
 */
export class Vad {
  readonly options: ResolvedVadOptions;

  private readonly frameSamples: number;
  private readonly preRollFrames: number;
  private readonly silenceFrames: number;
  private readonly minSpeechFrames: number;
  private readonly maxFrames: number;

  /** Samples that did not fill a whole frame on the previous push. */
  private leftover: Int16Array = new Int16Array(0);
  /** Rolling pre-roll of the most recent non-speech frames. */
  private preRoll: Int16Array[] = [];
  private current: Int16Array[] = [];
  private speechFrames = 0;
  private silenceRun = 0;
  private active = false;

  /** Fired the moment speech starts. Barge-in uses this for fast audio stop. */
  onSpeechStart?: () => void;
  /**
   * Fired for every processed frame, speech or not, with its raw RMS energy.
   * The base VAD ignores this; it exists so `BargeInDetector` can sample the
   * mic continuously (to measure the echo floor and to tell a sustained
   * interruption from a brief onset) without duplicating frame math.
   */
  onFrame?: (energy: number) => void;

  constructor(opts?: VadOptions) {
    this.options = resolveVadOptions(opts);
    const { sampleRate, frameMs, preRollMs, silenceMs, minSpeechMs, maxUtteranceMs } =
      this.options;
    this.frameSamples = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
    this.preRollFrames = Math.ceil(preRollMs / frameMs);
    this.silenceFrames = Math.ceil(silenceMs / frameMs);
    this.minSpeechFrames = Math.ceil(minSpeechMs / frameMs);
    this.maxFrames = Math.ceil(maxUtteranceMs / frameMs);
  }

  /** True while the gate is open (speech in progress). */
  get speaking(): boolean {
    return this.active;
  }

  /** Feed PCM16 samples. Returns every utterance completed by this push. */
  push(samples: Int16Array): VadUtterance[] {
    const out: VadUtterance[] = [];

    // Join the leftover tail with the new samples, then walk whole frames.
    let buf: Int16Array;
    if (this.leftover.length === 0) {
      buf = samples;
    } else {
      buf = new Int16Array(this.leftover.length + samples.length);
      buf.set(this.leftover, 0);
      buf.set(samples, this.leftover.length);
    }

    let offset = 0;
    while (buf.length - offset >= this.frameSamples) {
      const frame = buf.subarray(offset, offset + this.frameSamples);
      offset += this.frameSamples;
      const done = this.pushFrame(frame);
      if (done) out.push(done);
    }
    this.leftover = buf.slice(offset);
    return out;
  }

  /**
   * End the current utterance now (client released push-to-talk, or the
   * session is stopping). Returns it when it is long enough to transcribe.
   */
  flush(): VadUtterance | null {
    if (!this.active) {
      this.leftover = new Int16Array(0);
      return null;
    }
    const utterance = this.finish(false);
    this.leftover = new Int16Array(0);
    return utterance;
  }

  /** Drop all buffered state without emitting anything. */
  reset(): void {
    this.leftover = new Int16Array(0);
    this.preRoll = [];
    this.current = [];
    this.speechFrames = 0;
    this.silenceRun = 0;
    this.active = false;
  }

  // ---- internals ----

  private pushFrame(frame: Int16Array): VadUtterance | null {
    const energy = frameEnergy(frame);
    this.onFrame?.(energy);
    const isSpeech = energy >= this.options.energyThreshold;

    if (!this.active) {
      if (!isSpeech) {
        // Keep the tail of the silence around as pre-roll.
        this.preRoll.push(Int16Array.from(frame));
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
        return null;
      }
      this.active = true;
      this.current = this.preRollFrames > 0 ? this.preRoll.slice() : [];
      this.preRoll = [];
      this.speechFrames = 0;
      this.silenceRun = 0;
      this.onSpeechStart?.();
    }

    this.current.push(Int16Array.from(frame));
    if (isSpeech) {
      this.speechFrames++;
      this.silenceRun = 0;
    } else {
      this.silenceRun++;
    }

    if (this.current.length >= this.maxFrames) return this.finish(true);
    if (this.silenceRun >= this.silenceFrames) return this.finish(false);
    return null;
  }

  /** Close the open utterance, returning it only if it holds enough speech. */
  private finish(truncated: boolean): VadUtterance | null {
    const frames = this.current;
    const speechFrames = this.speechFrames;
    this.current = [];
    this.preRoll = [];
    this.speechFrames = 0;
    this.silenceRun = 0;
    this.active = false;

    if (speechFrames < this.minSpeechFrames) return null;

    let total = 0;
    for (const f of frames) total += f.length;
    const pcm = new Int16Array(total);
    let at = 0;
    for (const f of frames) {
      pcm.set(f, at);
      at += f.length;
    }
    return {
      pcm,
      durationMs: Math.round((pcm.length / this.options.sampleRate) * 1000),
      endedAt: Date.now(),
      truncated,
    };
  }
}
