/**
 * Token Compressor — Core Engine (TC-1)
 *
 * Rule-based, deterministic compression for conversation context
 * before it reaches Claude API calls. Sits upstream of the API layer.
 *
 * Strategies:
 *   1. Deduplication — collapse repeated content blocks
 *   2. Whitespace normalization — collapse excessive whitespace/formatting
 *   3. Boilerplate stripping — remove low-value tokens (pleasantries, filler, repeated headers)
 *
 * Constraints:
 *   - Read-only: returns compressed copy, never mutates source
 *   - Deterministic: same input always produces same output
 *   - No third-party dependencies
 *   - Audit mode: returns diff of what was stripped
 */

// --- Types ---

export interface CompressionResult {
  /** The compressed text */
  output: string;
  /** Original character count */
  originalLength: number;
  /** Compressed character count */
  compressedLength: number;
  /** Compression ratio (0-1, lower = more compressed) */
  ratio: number;
  /** Audit log of what was removed/changed (only populated in audit mode) */
  audit: AuditEntry[];
}

export interface AuditEntry {
  strategy: "dedup" | "whitespace" | "boilerplate";
  description: string;
  /** Number of characters removed by this operation */
  charsRemoved: number;
}

export type CompressionLevel = "conservative" | "moderate" | "aggressive";

export interface CompressorOptions {
  /** Compression aggressiveness. Default: "moderate" */
  level?: CompressionLevel;
  /** Whether to populate audit log. Default: false */
  audit?: boolean;
  /** Number of recent messages to leave untouched. Default: 5 */
  protectedRecentCount?: number;
}

// --- Boilerplate patterns ---

// Pleasantries and filler phrases that add no semantic value
const BOILERPLATE_PHRASES: RegExp[] = [
  /^(?:Great question!|Absolutely!|Thanks for (?:the update|asking|sharing|your patience)!?|Sure thing!|Happy to help!|No problem!|Of course!|You're welcome!)\s*/gim,
  /(?:Let me know if you (?:have any (?:other )?questions|need anything else)[.!]?\s*)/gi,
  /(?:Hope that helps[.!]?\s*)/gi,
  /(?:I hope this (?:helps|is useful|answers your question)[.!]?\s*)/gi,
  /(?:Feel free to (?:ask|reach out|let me know)[.!]?\s*)/gi,
  /(?:Don't hesitate to (?:ask|reach out)[.!]?\s*)/gi,
];

// Repeated sign-off patterns bots tend to produce
const SIGNOFF_PATTERNS: RegExp[] = [
  /(?:Best regards|Cheers|Thanks again|Best|Regards),?\s*$/gim,
  /(?:— (?:Security|Medusa|Dev1|Dev2|Dev3))\s*$/gim,
];

// Redundant acknowledgment patterns (when the full context already contains the assignment)
const REDUNDANT_ACK_PATTERNS: RegExp[] = [
  /^(?:Acknowledged\.?|On it\.?|Roger that\.?|Copy\.?|Confirmed\.?)\s*$/gim,
];

// --- Core strategies ---

/**
 * Strategy 1: Deduplication
 * Detects and removes repeated content blocks within the text.
 * Operates on hub message blocks (lines starting with `[BotName @ timestamp]:`)
 */
export function deduplicateContent(
  text: string,
  audit: boolean = false
): { text: string; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  const lines = text.split("\n");
  const seen = new Map<string, number>(); // normalized content -> first occurrence line
  const removedLines = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Extract hub message content: [BotName @ timestamp]: content
    const hubMatch = line.match(/^\[.+? @ .+?\]:\s*(.+)$/);
    if (!hubMatch) continue;

    const content = hubMatch[1].trim();
    // Normalize: lowercase, collapse whitespace, strip timestamps for comparison
    const normalized = content
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[:\d.Z]*/g, "[TIME]")
      .trim();

    // Skip very short messages — dedup on those causes false positives
    if (normalized.length < 30) continue;

    if (seen.has(normalized)) {
      removedLines.add(i);
      if (audit) {
        entries.push({
          strategy: "dedup",
          description: `Removed duplicate message at line ${i + 1} (first seen at line ${seen.get(normalized)! + 1})`,
          charsRemoved: line.length + 1, // +1 for newline
        });
      }
    } else {
      seen.set(normalized, i);
    }
  }

  if (removedLines.size === 0) return { text, entries };

  const result = lines.filter((_, i) => !removedLines.has(i)).join("\n");
  return { text: result, entries };
}

/**
 * Strategy 2: Whitespace normalization
 * Collapses excessive whitespace while preserving structure.
 */
export function normalizeWhitespace(
  text: string,
  audit: boolean = false
): { text: string; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  const original = text;

  let result = text;

  // Collapse 3+ consecutive blank lines into 1
  result = result.replace(/\n{3,}/g, "\n\n");

  // Collapse trailing whitespace on lines
  result = result.replace(/[^\S\n]+$/gm, "");

  // Collapse runs of spaces/tabs within lines (but not leading indentation)
  result = result.replace(/([^\s])[ \t]{2,}([^\s])/g, "$1 $2");

  // Remove whitespace-only lines between hub message entries
  result = result.replace(
    /(\[.+? @ .+?\]:.*)\n\s*\n(\[.+? @ .+?\]:)/g,
    "$1\n$2"
  );

  const charsRemoved = original.length - result.length;
  if (charsRemoved > 0 && audit) {
    entries.push({
      strategy: "whitespace",
      description: `Normalized whitespace: removed ${charsRemoved} excess characters`,
      charsRemoved,
    });
  }

  return { text: result, entries };
}

/**
 * Strategy 3: Boilerplate stripping
 * Removes low-value tokens: pleasantries, filler, sign-offs.
 * Respects compression level for aggressiveness.
 */
export function stripBoilerplate(
  text: string,
  level: CompressionLevel = "moderate",
  audit: boolean = false
): { text: string; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  let result = text;

  // Conservative: only strip obvious pleasantries
  for (const pattern of BOILERPLATE_PHRASES) {
    const before = result.length;
    result = result.replace(pattern, "");
    const removed = before - result.length;
    if (removed > 0 && audit) {
      entries.push({
        strategy: "boilerplate",
        description: `Stripped pleasantry pattern: ${pattern.source.slice(0, 50)}...`,
        charsRemoved: removed,
      });
    }
  }

  // Moderate+: also strip sign-offs
  if (level === "moderate" || level === "aggressive") {
    for (const pattern of SIGNOFF_PATTERNS) {
      const before = result.length;
      result = result.replace(pattern, "");
      const removed = before - result.length;
      if (removed > 0 && audit) {
        entries.push({
          strategy: "boilerplate",
          description: `Stripped sign-off: ${pattern.source.slice(0, 50)}...`,
          charsRemoved: removed,
        });
      }
    }
  }

  // Aggressive: also strip redundant single-word acknowledgments
  if (level === "aggressive") {
    for (const pattern of REDUNDANT_ACK_PATTERNS) {
      const before = result.length;
      result = result.replace(pattern, "");
      const removed = before - result.length;
      if (removed > 0 && audit) {
        entries.push({
          strategy: "boilerplate",
          description: `Stripped redundant ack: ${pattern.source.slice(0, 50)}...`,
          charsRemoved: removed,
        });
      }
    }
  }

  // Clean up empty lines left behind by stripping
  result = result.replace(/\n{3,}/g, "\n\n");

  return { text: result, entries };
}

// --- Main API ---

/**
 * Compress text using all strategies in sequence.
 *
 * Pipeline: dedup → whitespace → boilerplate
 *
 * Recent messages (controlled by `protectedRecentCount`) are left untouched
 * to preserve semantic fidelity on the most relevant context.
 */
export function compress(
  text: string,
  options: CompressorOptions = {}
): CompressionResult {
  const {
    level = "moderate",
    audit = false,
    protectedRecentCount = 5,
  } = options;

  const originalLength = text.length;
  const allAudit: AuditEntry[] = [];

  // Split into protected (recent) and compressible (older) sections
  const { compressible, protected: protectedSection } = splitProtectedSection(
    text,
    protectedRecentCount
  );

  let compressed = compressible;

  // Pipeline: dedup → whitespace → boilerplate
  const dedupResult = deduplicateContent(compressed, audit);
  compressed = dedupResult.text;
  allAudit.push(...dedupResult.entries);

  const wsResult = normalizeWhitespace(compressed, audit);
  compressed = wsResult.text;
  allAudit.push(...wsResult.entries);

  const bpResult = stripBoilerplate(compressed, level, audit);
  compressed = bpResult.text;
  allAudit.push(...bpResult.entries);

  // Reassemble: compressed older section + protected recent section
  const output = protectedSection
    ? compressed + "\n" + protectedSection
    : compressed;

  const compressedLength = output.length;

  return {
    output,
    originalLength,
    compressedLength,
    ratio: originalLength > 0 ? compressedLength / originalLength : 1,
    audit: audit ? allAudit : [],
  };
}

/**
 * Split text into compressible (older) and protected (recent) sections.
 * "Recent" is defined by counting hub message lines from the end.
 */
function splitProtectedSection(
  text: string,
  protectedCount: number
): { compressible: string; protected: string } {
  if (protectedCount <= 0) {
    return { compressible: text, protected: "" };
  }

  const lines = text.split("\n");

  // Find hub message line indices (lines matching [BotName @ timestamp]: ...)
  const hubMessageIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\[.+? @ .+?\]:/.test(lines[i])) {
      hubMessageIndices.push(i);
    }
  }

  // If fewer hub messages than protectedCount, don't compress at all
  if (hubMessageIndices.length <= protectedCount) {
    return { compressible: "", protected: text };
  }

  // Find the split point: everything from the Nth-from-last hub message onward is protected
  const splitIndex = hubMessageIndices[hubMessageIndices.length - protectedCount];

  const compressible = lines.slice(0, splitIndex).join("\n");
  const protectedSection = lines.slice(splitIndex).join("\n");

  return { compressible, protected: protectedSection };
}

/**
 * Estimate token count from character length.
 * Rough heuristic: ~4 chars per token for English text.
 * Not a substitute for tiktoken but useful for quick estimates.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
