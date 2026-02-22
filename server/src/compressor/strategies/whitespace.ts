/**
 * Whitespace normalization strategy.
 * Collapses excessive whitespace while preserving fenced code blocks.
 * Pure regex — no deps, deterministic.
 */

import type {
  CompressionStrategy,
  AuditEntry,
  CompressionLevel,
} from "../types.js";

/** Max consecutive blank lines by compression level. */
const MAX_NEWLINES: Record<CompressionLevel, number> = {
  conservative: 2,
  moderate: 1,
  aggressive: 1,
};

interface Segment {
  text: string;
  isCode: boolean;
}

/**
 * Split text into alternating non-code / code-fence segments.
 * Code blocks (``` ... ```) are left untouched by normalization.
 */
function splitCodeBlocks(input: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /^```.*$/gm;
  let lastEnd = 0;
  let insideCode = false;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(input)) !== null) {
    const before = input.slice(lastEnd, match.index);
    if (before) {
      segments.push({ text: before, isCode: insideCode });
    }
    // The fence line itself belongs to the code block boundary
    insideCode = !insideCode;
    // Include the fence line in the code segment
    segments.push({ text: match[0], isCode: true });
    lastEnd = match.index + match[0].length;
  }

  // Remainder
  const tail = input.slice(lastEnd);
  if (tail) {
    segments.push({ text: tail, isCode: insideCode });
  }
  return segments;
}

export class WhitespaceStrategy implements CompressionStrategy {
  readonly name = "whitespace" as const;

  apply(
    input: string,
    audit: boolean,
    level: CompressionLevel
  ): { text: string; entries: AuditEntry[] } {
    const entries: AuditEntry[] = [];
    const maxNewlines = MAX_NEWLINES[level];
    const segments = splitCodeBlocks(input);

    const result = segments
      .map((seg) =>
        seg.isCode ? seg.text : this.normalize(seg.text, maxNewlines, audit, entries, level)
      )
      .join("");

    return { text: result, entries };
  }

  private normalize(
    text: string,
    maxNewlines: number,
    audit: boolean,
    entries: AuditEntry[],
    _level: CompressionLevel
  ): string {
    let result = text;

    // 1. Trailing whitespace on each line
    const trailingPattern = /[ \t]+$/gm;
    result = this.replace(result, trailingPattern, "", "trailing whitespace", audit, entries);

    // 2. Excessive consecutive newlines
    const newlineThreshold = maxNewlines + 1;
    const newlinePattern = new RegExp(`\\n{${newlineThreshold},}`, "g");
    const replacement = "\n".repeat(maxNewlines);
    result = this.replace(result, newlinePattern, replacement, "excessive blank lines", audit, entries);

    // 3. Multiple inline spaces (outside of line-leading indentation)
    // Process line by line to preserve intentional indentation
    const lines = result.split("\n");
    const normalized = lines.map((line) => {
      const leadingMatch = line.match(/^(\s*)/);
      const leading = leadingMatch ? leadingMatch[0] : "";
      const rest = line.slice(leading.length);
      // Collapse multiple spaces in the non-leading portion
      const collapsed = rest.replace(/[ \t]{2,}/g, " ");
      if (audit && collapsed !== rest) {
        entries.push({
          strategy: "whitespace",
          original: rest,
          replacement: collapsed,
          reason: "inline multi-space collapse",
        });
      }
      return leading + collapsed;
    });
    result = normalized.join("\n");

    return result;
  }

  private replace(
    text: string,
    pattern: RegExp,
    replacement: string,
    reason: string,
    audit: boolean,
    entries: AuditEntry[]
  ): string {
    if (!audit) {
      return text.replace(pattern, replacement);
    }

    return text.replace(pattern, (match) => {
      if (match !== replacement) {
        entries.push({
          strategy: "whitespace",
          original: match,
          replacement,
          reason,
        });
      }
      return replacement;
    });
  }
}
