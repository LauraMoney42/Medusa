/**
 * Deduplication strategy.
 * Removes exact-match repeated content blocks: hub messages, paragraphs, lines.
 * Deterministic — keeps the LAST occurrence of each duplicate (most recent is most relevant).
 */

import type {
  CompressionStrategy,
  AuditEntry,
  CompressionLevel,
} from "../types.js";
import { isSecurityContent } from "../types.js";

/** Minimum line length to consider for dedup, by level. */
const MIN_LENGTH: Record<CompressionLevel, number> = {
  conservative: 20,
  moderate: 10,
  aggressive: 5,
};

/** Matches hub message format: [BotName @ 2026-02-21T10:30:00.000Z]: message text */
const HUB_MSG_PATTERN = /^\[(.+?) @ (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]: (.+)$/;

export class DedupStrategy implements CompressionStrategy {
  readonly name = "dedup" as const;

  apply(
    input: string,
    audit: boolean,
    level: CompressionLevel
  ): { text: string; entries: AuditEntry[] } {
    const entries: AuditEntry[] = [];
    let result = input;

    // Phase 1: Hub message deduplication (same sender + same text → keep last)
    result = this.dedupHubMessages(result, audit, entries);

    // Phase 2: Repeated line/block deduplication
    result = this.dedupRepeatedLines(result, audit, entries, MIN_LENGTH[level]);

    return { text: result, entries };
  }

  /**
   * Parse hub messages and remove earlier duplicates (same from+text).
   * Keeps the last occurrence since it's the most recent/relevant.
   */
  private dedupHubMessages(
    input: string,
    audit: boolean,
    entries: AuditEntry[]
  ): string {
    const lines = input.split("\n");

    // First pass: find all hub messages and their dedup keys
    interface HubMsg {
      lineIndex: number;
      key: string; // normalized from+text
      line: string;
    }

    const hubMessages: HubMsg[] = [];
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(HUB_MSG_PATTERN);
      if (match) {
        const from = match[1].trim().toLowerCase();
        const text = match[3].trim().toLowerCase();
        hubMessages.push({
          lineIndex: i,
          key: `${from}||${text}`,
          line: lines[i],
        });
      }
    }

    // Build a set of line indices to remove (keep last occurrence of each key)
    const lastSeen = new Map<string, number>();
    for (const msg of hubMessages) {
      lastSeen.set(msg.key, msg.lineIndex);
    }

    const toRemove = new Set<number>();
    for (const msg of hubMessages) {
      if (isSecurityContent(msg.line)) continue;
      if (lastSeen.get(msg.key) !== msg.lineIndex) {
        toRemove.add(msg.lineIndex);
        if (audit) {
          entries.push({
            strategy: "dedup",
            original: msg.line,
            replacement: "",
            reason: "duplicate hub message",
          });
        }
      }
    }

    if (toRemove.size === 0) return input;

    return lines.filter((_, i) => !toRemove.has(i)).join("\n");
  }

  /**
   * Remove exact-match repeated lines/paragraphs.
   * Keeps the first occurrence, removes subsequent exact duplicates.
   */
  private dedupRepeatedLines(
    input: string,
    audit: boolean,
    entries: AuditEntry[],
    minLength: number
  ): string {
    const lines = input.split("\n");
    const seen = new Set<string>();
    const result: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Short lines, empty lines, and security content always pass through
      if (
        trimmed.length < minLength ||
        trimmed.length === 0 ||
        isSecurityContent(trimmed)
      ) {
        result.push(line);
        continue;
      }

      const key = trimmed.toLowerCase();
      if (seen.has(key)) {
        if (audit) {
          entries.push({
            strategy: "dedup",
            original: line,
            replacement: "",
            reason: "duplicate line",
          });
        }
        // Skip this duplicate line
        continue;
      }

      seen.add(key);
      result.push(line);
    }

    return result.join("\n");
  }
}
