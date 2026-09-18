/**
 * Splits a streaming assistant reply into speakable sentences.
 *
 * TTS latency is dominated by how soon the first sentence can be handed to
 * Kokoro, so this runs on the delta stream rather than on the finished
 * message. Two rules matter:
 *
 *  1. A terminator only ends a sentence when the buffer already holds the
 *     character after it. Waiting for that one extra character is what lets
 *     "Dr." and "3.5" stay whole when the stream happens to break there.
 *  2. A run of text with no terminator is cut at MAX_SENTENCE_CHARS, at the
 *     last word boundary, so a bulleted wall of text still starts speaking.
 */

/** Hard cap from the spec: a chunk never exceeds this many characters. */
export const MAX_SENTENCE_CHARS = 180;

/**
 * Tokens that end in a period without ending a sentence. Compared
 * case-insensitively against the word immediately before the period.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "mx", "dr", "prof", "sr", "jr", "st", "mt", "rev", "hon",
  "gen", "col", "capt", "lt", "sgt", "gov", "sen", "rep", "pres",
  "vs", "etc", "eg", "ie", "al", "approx", "est", "min", "max", "no", "fig",
  "dept", "univ", "inc", "ltd", "co", "corp", "assn", "bros",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "mon", "tue", "tues", "wed", "thu", "thurs", "fri", "sat", "sun",
  "am", "pm", "ca", "cf", "vol", "pp", "ed", "eds", "repr", "trans",
]);

/** True when the text ending at `idx` (the period) is a non-terminal period. */
function isAbbreviationPeriod(text: string, idx: number): boolean {
  // Walk back over the word attached to this period.
  let start = idx;
  while (start > 0 && /[A-Za-z0-9.]/.test(text[start - 1] as string)) start--;
  const word = text.slice(start, idx);
  if (word.length === 0) return false;

  // "U.S." / "e.g." / "a.m." — any dotted initialism keeps going.
  if (word.includes(".")) return true;
  // A single letter is an initial ("J. Smith"), not a sentence end.
  if (word.length === 1 && /[A-Za-z]/.test(word)) return true;
  // Decimal numbers: "3.5" never breaks, and "No. 4" is handled by the list.
  if (/^\d+$/.test(word) && /\d/.test(text[idx + 1] ?? "")) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Find the end index (exclusive) of the first complete sentence in `text`,
 * or -1 when the buffer does not yet contain one.
 *
 * `atEnd` = the caller knows no more text is coming, so a trailing terminator
 * counts even with nothing after it.
 */
export function findSentenceEnd(text: string, atEnd = false): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;

    if (ch === "\n") return i + 1;

    if (ch === "." || ch === "!" || ch === "?") {
      // Swallow a run of terminators and any closing quote/bracket.
      let j = i;
      while (j + 1 < text.length && /[.!?]/.test(text[j + 1] as string)) j++;
      while (j + 1 < text.length && /["'’”）)\]]/.test(text[j + 1] as string)) j++;

      const next = text[j + 1];
      if (next === undefined) {
        // Nothing after the terminator yet. Only commit at end of stream, and
        // only when the word is not an abbreviation waiting for its remainder.
        if (atEnd && !(ch === "." && isAbbreviationPeriod(text, i))) return j + 1;
        return -1;
      }
      if (!/\s/.test(next)) {
        // "3.5", "file.ts", "e.g.x" — not a boundary, keep scanning.
        i = j;
        continue;
      }
      if (ch === "." && isAbbreviationPeriod(text, i)) {
        i = j;
        continue;
      }
      return j + 1;
    }
  }
  return -1;
}

/**
 * Cut an over-long, terminator-free buffer at the last word boundary within
 * the cap. Returns -1 when the buffer is still under the cap.
 */
function findHardCut(text: string, cap: number): number {
  if (text.length <= cap) return -1;
  const window = text.slice(0, cap + 1);
  const lastSpace = Math.max(
    window.lastIndexOf(" "),
    window.lastIndexOf(","),
    window.lastIndexOf(";"),
    window.lastIndexOf(":")
  );
  if (lastSpace > cap * 0.4) return lastSpace + 1;
  return cap;
}

/**
 * Default cap for the FIRST chunk of a reply (S16). Kokoro's round trip is
 * roughly proportional to the text it is given, so the very first thing she
 * says should be as short as it can be while still sounding like the start of
 * a sentence: a clause, not a sentence.
 */
export const FIRST_CLAUSE_CHARS = 60;

/**
 * End index (exclusive) of the first clause in `text`, or -1.
 *
 * A clause boundary is a comma, semicolon, colon or dash followed by
 * whitespace. The terminator is kept: Kokoro's prosody uses it, so "Sure,"
 * is spoken with the right rising intonation rather than as a flat word.
 */
export function findClauseEnd(text: string, cap: number = FIRST_CLAUSE_CHARS): number {
  const limit = Math.min(text.length, cap);
  for (let i = 0; i < limit; i++) {
    const ch = text[i] as string;
    if (ch !== "," && ch !== ";" && ch !== ":" && ch !== "—" && ch !== "-") continue;
    const next = text[i + 1];
    if (next === undefined) return -1; // wait for the character after it
    if (!/\s/.test(next)) continue; // "3,500" and "state-of-the-art" are not clauses
    // A dash only splits when it is used as punctuation, i.e. spaced.
    if (ch === "-" && !/\s/.test(text[i - 1] ?? "x")) continue;
    return i + 1;
  }
  return -1;
}

export interface SentenceChunkerOptions {
  /**
   * When set, the first chunk of the turn may be cut at a clause boundary (or
   * this many characters at a word boundary) instead of waiting for a whole
   * sentence. Every chunk after the first uses sentence boundaries as before.
   */
  firstClauseChars?: number;
}

/** Streaming sentence splitter. One instance per assistant turn. */
export class SentenceChunker {
  private buffer = "";
  private readonly firstClauseChars: number;
  /** False until the first chunk of this turn has been emitted. */
  private emittedFirst = false;

  constructor(
    private readonly maxChars: number = MAX_SENTENCE_CHARS,
    options: SentenceChunkerOptions = {}
  ) {
    this.firstClauseChars = Math.max(0, options.firstClauseChars ?? 0);
  }

  /** Append a delta; returns every sentence that is now complete. */
  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  /** Emit whatever is left, splitting it at the cap if need be. */
  flush(): string[] {
    const out = this.drain(true);
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) out.push(rest);
    return out;
  }

  /** Discard buffered text (barge-in). */
  reset(): void {
    this.buffer = "";
    this.emittedFirst = false;
  }

  private drain(atEnd: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const cap =
        !this.emittedFirst && this.firstClauseChars > 0
          ? this.firstClauseChars
          : this.maxChars;
      let end = findSentenceEnd(this.buffer, atEnd);
      // First chunk in clause mode: whichever boundary comes first wins, and
      // a run with no boundary at all is cut at the (much smaller) cap.
      if (!this.emittedFirst && this.firstClauseChars > 0) {
        const clause = findClauseEnd(this.buffer, this.firstClauseChars);
        if (clause > 0 && (end < 0 || clause < end)) end = clause;
      }
      if (end < 0 || end > cap) {
        const cut = findHardCut(this.buffer, cap);
        if (cut < 0) break;
        end = cut;
      }
      const piece = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (piece) {
        out.push(piece);
        this.emittedFirst = true;
      }
      if (this.buffer.length === 0) break;
    }
    return out;
  }
}

/**
 * Strip the parts of a markdown reply that should not be read aloud (fenced
 * code, table pipes, heading hashes, list bullets, emphasis markers).
 */
export function speakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)[*_]([^*_]+)[*_]/g, "$1$2")
    .replace(/[ \t]{2,}/g, " ");
}
