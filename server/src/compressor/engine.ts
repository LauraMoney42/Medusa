/**
 * Token compression engine orchestrator.
 * Composes whitespace, dedup, and boilerplate strategies in a fixed order.
 *
 * Public API:
 *   compress(input, level?)          → { compressed }
 *   compress(input, level?, { audit: true }) → { compressed, audit: { compressed, removed, ratio } }
 *
 * Deterministic: same input + same options → identical output every time.
 * Read-only: never mutates the input. Zero network calls. Zero third-party deps.
 */

import type {
  CompressionLevel,
  CompressOptions,
  CompressResult,
  CompressionStrategy,
  AuditEntry,
  AuditReport,
  StrategyName,
} from "./types.js";
import { WhitespaceStrategy } from "./strategies/whitespace.js";
import { DedupStrategy } from "./strategies/dedup.js";
import { BoilerplateStrategy } from "./strategies/boilerplate.js";

/**
 * Build strategy pipeline.
 * Order matters: whitespace → dedup → boilerplate.
 * - Whitespace first: normalizes text so dedup can exact-match.
 * - Dedup second: removes duplicates before boilerplate scans.
 * - Boilerplate last: operates on clean, deduplicated text.
 */
function buildStrategies(): CompressionStrategy[] {
  return [
    new WhitespaceStrategy(),
    new DedupStrategy(),
    new BoilerplateStrategy(),
  ];
}

/** Default singleton pipeline — strategies are stateless, safe to reuse. */
const DEFAULT_STRATEGIES = buildStrategies();

/**
 * Compress text using rule-based strategies.
 *
 * @param input  Raw text to compress.
 * @param level  Compression aggressiveness. Default: "moderate".
 * @param options  Additional options (audit mode, per-strategy overrides).
 * @returns CompressResult with compressed text and optional audit report.
 */
export function compress(
  input: string,
  level: CompressionLevel = "moderate",
  options?: Omit<CompressOptions, "level">
): CompressResult {
  if (!input) {
    return { compressed: "" };
  }

  const audit = options?.audit ?? false;
  const strategyOpts = options?.strategies;
  const allEntries: AuditEntry[] = [];

  let text = input;

  for (const strategy of DEFAULT_STRATEGIES) {
    // Check if this strategy is disabled via options
    const opts = strategyOpts?.[strategy.name as keyof NonNullable<typeof strategyOpts>];
    if (opts && opts.enabled === false) continue;

    const result = strategy.apply(text, audit, level);
    text = result.text;

    if (audit) {
      allEntries.push(...result.entries);
    }
  }

  // Transparency marker per spec: show what was compressed
  // "[compressed: X->Y lines, removed: ...]"
  const inputLines = input.split("\n").length;
  const outputLines = text.split("\n").length;
  if (inputLines !== outputLines && text.length > 0) {
    const reasons = [...new Set(allEntries.map((e) => e.reason))];
    const marker = `[compressed: ${inputLines}->${outputLines} lines, removed: ${reasons.join(", ") || "whitespace"}]`;
    text = text.trimEnd() + "\n" + marker;
  }

  if (!audit) {
    return { compressed: text };
  }

  const ratio =
    input.length > 0 ? 1 - text.length / input.length : 0;

  const auditReport: AuditReport = {
    compressed: text,
    removed: allEntries,
    ratio: Math.round(ratio * 1000) / 1000, // 3 decimal places
  };

  return { compressed: text, audit: auditReport };
}

/**
 * Estimate the token count for a piece of text.
 * Rough approximation: ~4 chars per token for English text.
 * Used for metrics, not for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Re-export types for consumers
export type {
  CompressionLevel,
  CompressOptions,
  CompressResult,
  AuditReport,
  AuditEntry,
  StrategyName,
} from "./types.js";
