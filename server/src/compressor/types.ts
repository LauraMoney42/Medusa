/**
 * Shared types for the token compression engine.
 * Zero third-party deps — stdlib only.
 */

// ---- Strategy Identity ----

export type StrategyName = "dedup" | "whitespace" | "boilerplate";

export type CompressionLevel = "conservative" | "moderate" | "aggressive";

// ---- Audit Types ----

/** A single recorded transformation. */
export interface AuditEntry {
  strategy: StrategyName;
  original: string;
  replacement: string;
  reason: string;
}

/** Full audit report returned by compress() in audit mode. */
export interface AuditReport {
  /** The compressed output. */
  compressed: string;
  /** Every piece of content that was removed/replaced. */
  removed: AuditEntry[];
  /** Compression ratio: 1 - (outputLength / inputLength). 0 = no change, 1 = all removed. */
  ratio: number;
}

// ---- Configuration ----

export interface DedupOptions {
  enabled?: boolean;
  /** Minimum line length to consider for dedup. Default varies by level. */
  minLength?: number;
}

export interface WhitespaceOptions {
  enabled?: boolean;
  /** Max consecutive blank lines allowed. Default varies by level. */
  maxConsecutiveNewlines?: number;
}

export interface BoilerplateOptions {
  enabled?: boolean;
  /** Additional phrases to strip (merged with built-in list). */
  extraPhrases?: string[];
  /** Phrases that must NEVER be stripped. */
  protectedPhrases?: string[];
}

export interface CompressOptions {
  /** Compression aggressiveness. Default: "moderate". */
  level?: CompressionLevel;
  /** Enable audit mode — returns detailed removal log. Default: false. */
  audit?: boolean;
  /** Per-strategy overrides. */
  strategies?: {
    dedup?: DedupOptions;
    whitespace?: WhitespaceOptions;
    boilerplate?: BoilerplateOptions;
  };
}

// ---- Result ----

export interface CompressResult {
  /** The compressed text. */
  compressed: string;
  /** Present only when audit mode is enabled. */
  audit?: AuditReport;
}

// ---- Strategy Contract ----

export interface CompressionStrategy {
  readonly name: StrategyName;
  apply(input: string, audit: boolean, level: CompressionLevel): {
    text: string;
    entries: AuditEntry[];
  };
}

// ---- Security Content Protection ----

/**
 * Patterns that indicate security-relevant content.
 * Lines matching these MUST NEVER be stripped by any strategy.
 * Per spec: "Tool MUST NOT strip security-relevant content"
 */
const SECURITY_PATTERNS =
  /(?:APPROVAL NEEDED|security|escalat|auth.?warn|blocked|denied|verdict|CRITICAL|🚨|permission.?denied|unauthorized|forbidden|API.?KEY|SECRET|TOKEN|PRIVATE.?KEY)/i;

export function isSecurityContent(text: string): boolean {
  return SECURITY_PATTERNS.test(text);
}
