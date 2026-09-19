/**
 * Mic gate for the window in which she is speaking. PIPELINE TIER ONLY.
 *
 * The echo guard ducks the *sent* mic level while the assistant speaks
 * (MicCapture.setSentGain), but ducking is not silencing: on a laptop the
 * speaker still leaks into the mic, and the server's Whisper/VAD loop will
 * transcribe that leakage as a user turn. So while she speaks, a frame has to
 * earn its way out. This is the client side of the same rule
 * `server/src/voice/barge-in.ts` applies on the pipeline tier, with the same
 * defaults:
 *
 *  - the first `floorMeasureMs` of each spoken turn are used to measure how
 *    loud her own echo actually is on this speaker setup (the gate stays shut
 *    throughout), so a loud speaker cannot defeat the gate;
 *  - after that a frame must clear `max(threshold, measured x multiplier)`;
 *  - and it must stay there for `minSpeechMs` continuously, not just touch it.
 *
 * Once the gate opens it stays open until she stops speaking, so a real
 * barge-in is never chopped mid-word, and the frames that opened it are
 * released too, so the first syllable is not lost either.
 *
 * Live tier gets no gate at all: Gemini runs its own VAD on the mic stream and
 * needs it continuous, so `lib/voice/micGating.ts` refuses to build one there.
 * Withholding frames from a server-side VAD is not caution, it is deafness: it
 * left the user's second turn unheard.
 */

export interface EchoGateOptions {
  /**
   * Absolute RMS floor in int16 units, measured on the frame as it would be
   * sent (i.e. after the echo guard's duck).
   */
  floor: number;
  /** Continuous time above the floor before the gate opens. Default 300 ms. */
  minSpeechMs?: number;
  /** Window at the start of each spoken turn used to sample the echo. Default 500 ms. */
  floorMeasureMs?: number;
  /** Multiple of the measured echo the bar is raised to. Default 2. */
  floorMultiplier?: number;
  /** Frame length in ms; MicCapture produces 100 ms frames. */
  frameMs?: number;
}

/** RMS of a PCM16 frame, in int16 units. */
export function frameRms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i];
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * The absolute floor for a given barge-in threshold and duck factor. The
 * frames the gate sees have already been multiplied by the duck factor, so
 * the threshold has to come down by the same amount or nothing would pass.
 */
export function floorFor(bargeInEnergyThreshold: number, duckFactor: number): number {
  return Math.max(80, bargeInEnergyThreshold * Math.max(0.05, Math.min(1, duckFactor)));
}

export class EchoGate {
  private speaking = false;
  private open = false;
  private held: Int16Array[] = [];
  private loudMs = 0;
  private measuredMs = 0;
  private measuredPeak = 0;

  private readonly floor: number;
  private readonly minSpeechMs: number;
  private readonly floorMeasureMs: number;
  private readonly floorMultiplier: number;
  private readonly frameMs: number;

  constructor(opts: EchoGateOptions) {
    this.floor = opts.floor;
    this.minSpeechMs = opts.minSpeechMs ?? 300;
    this.floorMeasureMs = opts.floorMeasureMs ?? 500;
    this.floorMultiplier = Math.max(1, opts.floorMultiplier ?? 2);
    this.frameMs = Math.max(1, opts.frameMs ?? 100);
  }

  /** Loop state changed. Every transition re-arms the gate and the measurement. */
  setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.open = false;
    this.held = [];
    this.loudMs = 0;
    this.measuredMs = 0;
    this.measuredPeak = 0;
  }

  /** False only while she is speaking and nothing loud enough has been heard. */
  get isOpen(): boolean {
    return this.open || !this.speaking;
  }

  /** The bar a frame has to clear right now, for diagnostics and tests. */
  get threshold(): number {
    return Math.max(this.floor, this.measuredPeak * this.floorMultiplier);
  }

  /**
   * Which frames to actually send for this captured frame: the frame itself
   * when she is not speaking or the gate is already open, the frames that
   * opened the gate on the frame that opens it, and nothing at all while it
   * is shut.
   */
  accept(frame: Int16Array): Int16Array[] {
    if (!this.speaking || this.open) return [frame];
    const rms = frameRms(frame);

    // Measurement window: this is what her own echo sounds like here.
    if (this.measuredMs < this.floorMeasureMs) {
      this.measuredMs += this.frameMs;
      this.measuredPeak = Math.max(this.measuredPeak, rms);
      return [];
    }

    if (rms < this.threshold) {
      this.held = [];
      this.loudMs = 0;
      return [];
    }
    this.held.push(frame);
    this.loudMs += this.frameMs;
    if (this.loudMs < this.minSpeechMs) return [];
    this.open = true;
    const release = this.held;
    this.held = [];
    return release;
  }
}
