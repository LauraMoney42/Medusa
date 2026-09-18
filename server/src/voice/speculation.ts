/**
 * Speculative turn start (S16).
 *
 * The final transcript only exists after the VAD's 600 ms silence hangover
 * plus Whisper's ~300 ms round trip, so almost a second of the reply's latency
 * is spent waiting for text the partial hypothesis already had. When a partial
 * has stopped changing and looks like a finished thought, the engine turn is
 * started on it; when the real transcript lands it is compared with what was
 * spoken, and only a materially different one costs an abort and a restart.
 *
 * Everything here is pure: the decisions are functions of text and a clock,
 * which is what makes the abort/restart rule testable without any audio.
 */

/** Stability window: a partial must stop changing for this long. */
export const STABLE_MS = 400;
/** Stability alone counts as "a pause" after this long, punctuation or not. */
export const PAUSE_MS = 700;
/** Normalized edit distance above which the speculation is thrown away. */
export const DIVERGENCE_THRESHOLD = 0.25;

/**
 * Sentence-final punctuation, ignoring a trailing quote or bracket.
 *
 * An ellipsis is explicitly NOT sentence-final: Whisper writes one when the
 * audio it was given stops mid-thought, which is exactly what every partial
 * window is, so treating "Tell me in two sentences..." as a finished question
 * made the speculative start fire on half a sentence and then throw the turn
 * away a second later. Observed on this machine, 2026-09-18.
 */
export function endsWithSentencePunctuation(text: string): boolean {
  const trimmed = text.trim();
  if (/(\.\.\.|…)["'’”)\]]*$/.test(trimmed)) return false;
  return /[.!?]["'’”)\]]*\s*$/.test(trimmed);
}

/**
 * Lowercase, drop punctuation, collapse whitespace. Comparing on this is what
 * stops "hello there" and "Hello, there." from counting as a divergence: the
 * engine would have been given the same instruction either way.
 */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Classic Levenshtein distance, two rows rather than a full matrix. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost
      );
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length] as number;
}

/** Levenshtein over normalized text, divided by the longer string's length. */
export function normalizedDistance(a: string, b: string): number {
  const na = normalizeTranscript(a);
  const nb = normalizeTranscript(b);
  if (!na && !nb) return 0;
  const longest = Math.max(na.length, nb.length);
  if (longest === 0) return 0;
  return levenshtein(na, nb) / longest;
}

/**
 * True when a turn started on `spoken` has to be abandoned in favour of
 * `final`. An empty speculation is always wrong; anything past the threshold
 * is a different question.
 */
export function shouldAbortSpeculation(
  spoken: string,
  final: string,
  threshold: number = DIVERGENCE_THRESHOLD
): boolean {
  if (!spoken.trim()) return true;
  const spokenNorm = normalizeTranscript(spoken);
  const finalNorm = normalizeTranscript(final);
  if (!spokenNorm) return true;
  // The guess is a strict prefix of what was actually said: the user kept
  // talking, and the part that was cut off is the part that carries the
  // question. Measured on this machine, "tell me in two sentences why this"
  // against "tell me in two sentences why the sky is blue" scores exactly at
  // the threshold, so distance alone would have kept the turn and she would
  // have answered "your message got cut off".
  if (finalNorm.length > spokenNorm.length && finalNorm.startsWith(spokenNorm)) return true;
  return normalizedDistance(spoken, final) > threshold;
}

export interface SpeculationOptions {
  stableMs?: number;
  pauseMs?: number;
  /** Shorter hypotheses are noise, not a question. */
  minChars?: number;
  enabled?: boolean;
}

/**
 * Watches the partial stream and says when to jump the gun.
 *
 * `onPartial` records each new hypothesis with the time it first appeared;
 * `check(now)` is called on the same cadence audio arrives and returns the
 * text to start a turn on, or null. It fires at most once per utterance.
 */
export class SpeculationTracker {
  private text = "";
  private since = 0;
  private fired = false;
  /** Consecutive partials that said exactly the same thing. */
  private repeats = 0;

  readonly stableMs: number;
  readonly pauseMs: number;
  readonly minChars: number;
  readonly enabled: boolean;

  constructor(options: SpeculationOptions = {}) {
    this.stableMs = options.stableMs ?? STABLE_MS;
    this.pauseMs = options.pauseMs ?? PAUSE_MS;
    this.minChars = options.minChars ?? 4;
    this.enabled = options.enabled ?? true;
  }

  /** The hypothesis the turn was (or would be) started on. */
  get candidate(): string {
    return this.text;
  }

  /** True once a speculative turn has been started for this utterance. */
  get started(): boolean {
    return this.fired;
  }

  /** A new partial arrived. Resets the stability clock when the text changed. */
  onPartial(text: string, now: number): void {
    const clean = text.trim();
    if (clean === this.text) {
      this.repeats++;
      return;
    }
    this.text = clean;
    this.since = now;
    this.repeats = 0;
  }

  /**
   * The text to start a turn on, or null. Two ways to qualify: stable for
   * `stableMs` and ending in sentence punctuation, or stable long enough that
   * the silence is itself the end of the thought.
   */
  check(now: number): string | null {
    if (!this.enabled || this.fired || !this.text) return null;
    if (this.text.length < this.minChars) return null;
    const stableFor = now - this.since;
    const punctuated = endsWithSentencePunctuation(this.text);
    if (stableFor < (punctuated ? this.stableMs : this.pauseMs)) return null;
    // An unpunctuated hypothesis also has to have been CONFIRMED by a second
    // identical partial. The rolling-window provider only speaks every 700 ms,
    // so wall-clock stillness on its own just means "no new window yet", not
    // "the user stopped talking".
    if (!punctuated && this.repeats < 1) return null;
    this.fired = true;
    return this.text;
  }

  /** New utterance. */
  reset(): void {
    this.text = "";
    this.since = 0;
    this.fired = false;
    this.repeats = 0;
  }
}
