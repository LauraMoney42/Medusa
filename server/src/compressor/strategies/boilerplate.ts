/**
 * Boilerplate stripping strategy.
 * Removes low-value tokens: pleasantries, sign-offs, filler phrases, redundant acks.
 * Abbreviates timestamps when all hub messages share the same date.
 * Security-relevant lines are always preserved.
 */

import type {
  CompressionStrategy,
  AuditEntry,
  CompressionLevel,
} from "../types.js";
import { isSecurityContent } from "../types.js";

// ---- Pattern definitions ----

interface PatternDef {
  pattern: RegExp;
  reason: string;
  replacement: string;
}

/** Pleasantries that appear at the start of a line/message. */
const PLEASANTRIES: PatternDef[] = [
  { pattern: /^Great question!\s*/gim, reason: "pleasantry", replacement: "" },
  { pattern: /^Absolutely!\s*/gim, reason: "pleasantry", replacement: "" },
  { pattern: /^Thanks for the update!\s*/gim, reason: "pleasantry", replacement: "" },
  { pattern: /^Happy to help[.!]?\s*/gim, reason: "pleasantry", replacement: "" },
  { pattern: /^Sure thing[.!]?\s*/gim, reason: "pleasantry", replacement: "" },
  { pattern: /^Of course[.!]?\s*/gim, reason: "pleasantry", replacement: "" },
  { pattern: /^That's a great point[.!]?\s*/gim, reason: "pleasantry", replacement: "" },
  { pattern: /^Good catch[.!]?\s*/gim, reason: "pleasantry", replacement: "" },
  { pattern: /^No problem[.!]?\s*/gim, reason: "pleasantry", replacement: "" },
  { pattern: /^Great work[.!]?\s*/gim, reason: "pleasantry", replacement: "" },
  { pattern: /^Sounds good[.!]?\s*/gim, reason: "pleasantry", replacement: "" },
  { pattern: /^Perfect[.!]?\s*/gim, reason: "pleasantry", replacement: "" },
];

/** Sign-offs that appear at the end of a line/message. */
const SIGN_OFFS: PatternDef[] = [
  { pattern: /\s*Let me know if you need anything else[.!]?\s*$/gim, reason: "sign-off", replacement: "" },
  { pattern: /\s*Feel free to ask[.!]?\s*$/gim, reason: "sign-off", replacement: "" },
  { pattern: /\s*Hope that helps[.!]?\s*$/gim, reason: "sign-off", replacement: "" },
  { pattern: /\s*Don't hesitate to reach out[.!]?\s*$/gim, reason: "sign-off", replacement: "" },
  { pattern: /\s*Let me know if you have any questions[.!]?\s*$/gim, reason: "sign-off", replacement: "" },
  { pattern: /\s*I'm here if you need me[.!]?\s*$/gim, reason: "sign-off", replacement: "" },
];

/** Restated context phrases at start of sentences. */
const RESTATED_CONTEXT: PatternDef[] = [
  { pattern: /As (?:I )?mentioned (?:earlier|before|above),?\s*/gi, reason: "restated context", replacement: "" },
  { pattern: /As (?:I )?said (?:earlier|before|above),?\s*/gi, reason: "restated context", replacement: "" },
  { pattern: /As (?:I )?noted (?:earlier|before|above),?\s*/gi, reason: "restated context", replacement: "" },
  { pattern: /As previously discussed,?\s*/gi, reason: "restated context", replacement: "" },
  { pattern: /Like I mentioned,?\s*/gi, reason: "restated context", replacement: "" },
];

/** Filler phrases stripped inline (sentence structure preserved). */
const FILLER_PHRASES: PatternDef[] = [
  { pattern: /\b(?:basically|essentially),?\s*/gi, reason: "filler phrase", replacement: "" },
  { pattern: /\bit's worth noting that\s*/gi, reason: "filler phrase", replacement: "" },
  { pattern: /\bit should be noted that\s*/gi, reason: "filler phrase", replacement: "" },
  { pattern: /\bto be (?:completely )?honest,?\s*/gi, reason: "filler phrase", replacement: "" },
  { pattern: /\bin my opinion,?\s*/gi, reason: "filler phrase", replacement: "" },
];

/** Lines that are pure ack messages — keep first, remove subsequent. */
const ACK_PATTERNS = [
  /^acknowledged\.?$/i,
  /^\[NO-ACTION\]$/i,
  /^confirmed\.?$/i,
  /^roger that\.?$/i,
  /^copy that\.?$/i,
  /^understood\.?$/i,
  /^on it\.?$/i,
];

/**
 * Which pattern categories to apply at each compression level.
 * Conservative: only pleasantries + sign-offs.
 * Moderate: + filler phrases + restated context + ack dedup.
 * Aggressive: + timestamp abbreviation.
 */
const LEVEL_CONFIG: Record<
  CompressionLevel,
  {
    pleasantries: boolean;
    signOffs: boolean;
    restatedContext: boolean;
    fillerPhrases: boolean;
    ackDedup: boolean;
    timestampAbbrev: boolean;
  }
> = {
  conservative: {
    pleasantries: true,
    signOffs: true,
    restatedContext: false,
    fillerPhrases: false,
    ackDedup: false,
    timestampAbbrev: false,
  },
  moderate: {
    pleasantries: true,
    signOffs: true,
    restatedContext: true,
    fillerPhrases: true,
    ackDedup: true,
    timestampAbbrev: false,
  },
  aggressive: {
    pleasantries: true,
    signOffs: true,
    restatedContext: true,
    fillerPhrases: true,
    ackDedup: true,
    timestampAbbrev: true,
  },
};

/** Matches ISO timestamp in hub message format. */
const TIMESTAMP_PATTERN = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}\.\d{3}Z/g;

export class BoilerplateStrategy implements CompressionStrategy {
  readonly name = "boilerplate" as const;

  apply(
    input: string,
    audit: boolean,
    level: CompressionLevel
  ): { text: string; entries: AuditEntry[] } {
    const entries: AuditEntry[] = [];
    const config = LEVEL_CONFIG[level];
    let result = input;

    // Apply pattern categories based on level
    if (config.pleasantries) {
      result = this.applyPatterns(result, PLEASANTRIES, audit, entries);
    }
    if (config.signOffs) {
      result = this.applyPatterns(result, SIGN_OFFS, audit, entries);
    }
    if (config.restatedContext) {
      result = this.applyPatterns(result, RESTATED_CONTEXT, audit, entries);
    }
    if (config.fillerPhrases) {
      result = this.applyPatterns(result, FILLER_PHRASES, audit, entries);
    }
    if (config.ackDedup) {
      result = this.dedupAcks(result, audit, entries);
    }
    if (config.timestampAbbrev) {
      result = this.abbreviateTimestamps(result, audit, entries);
    }

    // Clean up lines that became empty after stripping
    result = this.removeEmptyResultLines(result);

    return { text: result, entries };
  }

  /**
   * Apply a set of regex patterns, skipping security-exempt lines.
   */
  private applyPatterns(
    text: string,
    patterns: PatternDef[],
    audit: boolean,
    entries: AuditEntry[]
  ): string {
    let result = text;

    for (const def of patterns) {
      // Reset regex state (they have /g flag)
      def.pattern.lastIndex = 0;

      if (!audit) {
        // Fast path: apply per line, skip security lines
        result = this.replacePerLine(result, def.pattern, def.replacement);
        continue;
      }

      // Audit path: track each replacement
      result = this.replacePerLine(result, def.pattern, def.replacement, (original, replacement) => {
        entries.push({
          strategy: "boilerplate",
          original,
          replacement,
          reason: def.reason,
        });
      });
    }

    return result;
  }

  /**
   * Apply regex per line, skipping security-exempt lines.
   * Optional callback for audit tracking.
   */
  private replacePerLine(
    text: string,
    pattern: RegExp,
    replacement: string,
    onReplace?: (original: string, replacement: string) => void
  ): string {
    const lines = text.split("\n");
    const result = lines.map((line) => {
      if (isSecurityContent(line)) return line;

      // Clone regex to avoid shared state issues
      const re = new RegExp(pattern.source, pattern.flags);
      const replaced = line.replace(re, replacement);
      if (replaced !== line && onReplace) {
        onReplace(line, replaced);
      }
      return replaced;
    });
    return result.join("\n");
  }

  /**
   * Keep first ack message of each type, remove subsequent identical ones.
   */
  private dedupAcks(
    text: string,
    audit: boolean,
    entries: AuditEntry[]
  ): string {
    const lines = text.split("\n");
    const seenAckTypes = new Set<number>();
    const result: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      let isAck = false;

      for (let i = 0; i < ACK_PATTERNS.length; i++) {
        if (ACK_PATTERNS[i].test(trimmed)) {
          if (seenAckTypes.has(i)) {
            // Duplicate ack — skip
            if (audit) {
              entries.push({
                strategy: "boilerplate",
                original: line,
                replacement: "",
                reason: "redundant ack",
              });
            }
            isAck = true;
            break;
          }
          seenAckTypes.add(i);
          break;
        }
      }

      if (!isAck) {
        result.push(line);
      }
    }

    return result.join("\n");
  }

  /**
   * If all hub message timestamps share the same date, abbreviate to HH:MM.
   * Deterministic: depends only on content, not current time.
   */
  private abbreviateTimestamps(
    text: string,
    audit: boolean,
    entries: AuditEntry[]
  ): string {
    // Collect all dates from timestamps
    const dates = new Set<string>();
    const matches = text.matchAll(TIMESTAMP_PATTERN);
    for (const m of matches) {
      dates.add(m[1]);
    }

    // Only abbreviate if all timestamps share the same date
    if (dates.size !== 1) return text;

    // Replace full ISO timestamps with HH:MM
    return text.replace(TIMESTAMP_PATTERN, (_full, _date: string, time: string) => {
      if (audit) {
        entries.push({
          strategy: "boilerplate",
          original: _full,
          replacement: time,
          reason: "timestamp abbreviation (same-day)",
        });
      }
      return time;
    });
  }

  /**
   * Remove lines that became empty (only whitespace) after pattern stripping.
   * Preserves intentional blank lines by only removing lines that had content before.
   */
  private removeEmptyResultLines(text: string): string {
    const lines = text.split("\n");
    return lines.filter((line) => line.trim().length > 0 || line.length === 0).join("\n");
  }
}
