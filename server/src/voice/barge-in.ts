/**
 * Tells her own voice coming back through the mic apart from a real
 * interruption.
 *
 * The plain `Vad` (vad.ts) opens its gate at a single energy threshold
 * (500), which is right for "has the user started talking" during normal
 * listening but wrong while she is thinking or speaking: on laptop
 * speakers, her own playback leaks into the mic well above that threshold,
 * so every onset of her own reply looked like a barge-in and playback got
 * cut to text-only mid-reply.
 *
 * `BargeInDetector` is only consulted during that window (thinking,
 * speaking, and a short grace period after speaking ends). It asks for
 * more than the base VAD does before it calls something a barge-in:
 *  - the energy has to clear a much higher bar (`bargeInEnergyThreshold`,
 *    4x the base VAD threshold by default), and
 *  - it has to stay above that bar for `bargeInMinSpeechMs` (default
 *    300 ms) continuously, not just touch it for one frame.
 *
 * It also adapts: the first `floorMeasureMs` of each utterance's playback
 * are used to sample how loud her own echo actually is on this speaker
 * setup, and the bar is raised to `floorMultiplier` times that measured
 * level when it is higher than the static default. Loud speaker volume
 * should not be able to defeat the fix.
 */

import { VAD_DEFAULTS } from "./vad.js";

export interface BargeInOptions {
  /** Frame energy that counts as a candidate interruption. Default 4x the base VAD threshold. */
  bargeInEnergyThreshold?: number;
  /** Continuous time above the threshold required before it counts as a barge-in. */
  bargeInMinSpeechMs?: number;
  /** How long after speaking ends detection stays armed. */
  graceMs?: number;
  /** Window at the start of each utterance's playback used to sample the echo floor. */
  floorMeasureMs?: number;
  /** Multiple of the measured echo floor the adaptive threshold is raised to. */
  floorMultiplier?: number;
}

export interface ResolvedBargeInOptions extends Required<BargeInOptions> {}

export const BARGE_IN_DEFAULTS: ResolvedBargeInOptions = {
  bargeInEnergyThreshold: VAD_DEFAULTS.energyThreshold * 4, // 2000
  bargeInMinSpeechMs: 300,
  graceMs: 400,
  floorMeasureMs: 500,
  floorMultiplier: 2,
};

/** Resolve partial options against the defaults, clamping the silly values. */
export function resolveBargeInOptions(opts?: BargeInOptions): ResolvedBargeInOptions {
  const merged = { ...BARGE_IN_DEFAULTS, ...(opts ?? {}) };
  return {
    ...merged,
    bargeInEnergyThreshold: Math.max(1, merged.bargeInEnergyThreshold),
    bargeInMinSpeechMs: Math.max(0, merged.bargeInMinSpeechMs),
    graceMs: Math.max(0, merged.graceMs),
    floorMeasureMs: Math.max(0, merged.floorMeasureMs),
    floorMultiplier: Math.max(1, merged.floorMultiplier),
  };
}

/** A VAD onset that opened during the armed window but never earned a barge-in. */
export interface IgnoredOnset {
  /** Peak frame energy seen during the onset. */
  energy: number;
  /** Longest continuous run above the barge-in threshold, in ms (0 if it never crossed). */
  ms: number;
}

export type BargeInFrameResult =
  | { kind: "inactive" }
  | { kind: "barging"; energy: number; ms: number };

export class BargeInDetector {
  readonly options: ResolvedBargeInOptions;

  private active = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- adaptive floor ----
  private threshold: number;
  private measuring = false;
  private measuredMs = 0;
  private measuredPeak = 0;

  // ---- current onset ----
  private inOnset = false;
  private sustainMs = 0;
  private onsetPeak = 0;
  private peakSustainMs = 0;
  private barged = false;

  constructor(opts?: BargeInOptions) {
    this.options = resolveBargeInOptions(opts);
    this.threshold = this.options.bargeInEnergyThreshold;
  }

  /** True while thinking, speaking, or within the post-speaking grace window. */
  get isActive(): boolean {
    return this.active;
  }

  /** The threshold currently in force, after any adaptive floor adjustment. */
  get currentThreshold(): number {
    return this.threshold;
  }

  /** Enter the armed window (call when she starts thinking or speaking). */
  activate(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.active = true;
  }

  /** Speaking ended: stay armed for `graceMs` more, then disarm. */
  deactivateAfterGrace(): void {
    if (!this.active) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.active = false;
      this.measuring = false;
      this.graceTimer = null;
    }, this.options.graceMs);
  }

  /** Disarm immediately (session stopped, explicit interrupt already handled it). */
  deactivate(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.active = false;
    this.measuring = false;
    this.resetOnset();
  }

  /** Audio actually started playing for this turn: begin sampling the echo floor. */
  beginPlayback(): void {
    this.threshold = this.options.bargeInEnergyThreshold;
    this.measuring = true;
    this.measuredMs = 0;
    this.measuredPeak = 0;
  }

  /** A VAD onset opened while active. Resets the per-onset accounting. */
  beginOnset(): void {
    this.resetOnset();
    this.inOnset = true;
  }

  private resetOnset(): void {
    this.inOnset = false;
    this.sustainMs = 0;
    this.onsetPeak = 0;
    this.peakSustainMs = 0;
    this.barged = false;
  }

  /**
   * The VAD onset closed (its silence hangover elapsed). Returns the
   * onset's summary when it never earned a real barge-in, so the caller can
   * log it and drop the transcript it produced; `null` when it already did
   * (the "barging" result was returned from `pushFrame` earlier).
   */
  endOnset(): IgnoredOnset | null {
    if (!this.inOnset) return null;
    const wasBarged = this.barged;
    const result: IgnoredOnset = { energy: this.onsetPeak, ms: this.peakSustainMs };
    this.resetOnset();
    return wasBarged ? null : result;
  }

  /**
   * Feed one frame's RMS energy. Safe to call on every VAD frame regardless
   * of onset state; it is a no-op outside the armed window and outside an
   * open onset (beyond sampling the echo floor).
   */
  pushFrame(energy: number, frameMs: number): BargeInFrameResult {
    if (!this.active) return { kind: "inactive" };

    if (this.measuring) {
      this.measuredPeak = Math.max(this.measuredPeak, energy);
      this.measuredMs += frameMs;
      if (this.measuredMs >= this.options.floorMeasureMs) {
        this.measuring = false;
        const adaptive = this.measuredPeak * this.options.floorMultiplier;
        this.threshold = Math.max(this.options.bargeInEnergyThreshold, adaptive);
      }
    }

    if (!this.inOnset) return { kind: "inactive" };

    this.onsetPeak = Math.max(this.onsetPeak, energy);
    if (energy >= this.threshold) {
      this.sustainMs += frameMs;
      if (this.sustainMs > this.peakSustainMs) this.peakSustainMs = this.sustainMs;
    } else {
      this.sustainMs = 0;
    }

    if (!this.barged && this.peakSustainMs >= this.options.bargeInMinSpeechMs) {
      this.barged = true;
      return { kind: "barging", energy: this.onsetPeak, ms: this.peakSustainMs };
    }
    return { kind: "inactive" };
  }
}
