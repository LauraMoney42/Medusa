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
 *
 * TC-2: Config system integration — supports exclusion patterns and safety limits
 * loaded from ~/.claude-chat/compressor.json (or --config path).
 */

import type {
  CompressionLevel,
  CompressOptions,
  CompressResult,
  CompressionStrategy,
  AuditEntry,
  AuditReport,
  StrategyName,
  CompressorConfig,
  SafetyLimits,
} from "./types.js";
import { DEFAULT_SAFETY_LIMITS } from "./types.js";
import { WhitespaceStrategy } from "./strategies/whitespace.js";
import { DedupStrategy } from "./strategies/dedup.js";
import { BoilerplateStrategy } from "./strategies/boilerplate.js";
import { compileExclusionPatterns, isExcluded } from "./config.js";

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
 * Apply exclusion patterns: mark excluded lines so strategies skip them.
 * Uses sentinel wrapping — excluded lines are replaced with a unique placeholder
 * before compression, then restored after. This ensures strategies can't touch them.
 */
const EXCLUSION_SENTINEL = "\x00__EXCL__";
const EXCLUSION_SENTINEL_END = "__EXCL__\x00";

function protectExcludedLines(
  input: string,
  compiledPatterns: RegExp[]
): { text: string; restorations: Map<string, string> } {
  if (compiledPatterns.length === 0) {
    return { text: input, restorations: new Map() };
  }

  const lines = input.split("\n");
  const restorations = new Map<string, string>();
  let counter = 0;

  const result = lines.map((line) => {
    if (isExcluded(line, compiledPatterns)) {
      const key = `${EXCLUSION_SENTINEL}${counter}${EXCLUSION_SENTINEL_END}`;
      restorations.set(key, line);
      counter++;
      return key;
    }
    return line;
  });

  return { text: result.join("\n"), restorations };
}

function restoreExcludedLines(
  text: string,
  restorations: Map<string, string>
): string {
  if (restorations.size === 0) return text;

  let result = text;
  for (const [key, original] of restorations) {
    result = result.replace(key, original);
  }
  return result;
}

/**
 * Enforce safety limits on compressed output.
 * Returns original input if limits are violated — fail-safe design.
 */
function enforceSafetyLimits(
  original: string,
  compressed: string,
  limits: SafetyLimits,
  audit: boolean,
  entries: AuditEntry[]
): { text: string; limitTriggered: boolean } {
  const ratio = original.length > 0 ? 1 - compressed.length / original.length : 0;

  // Max compression ratio check — too aggressive = return original
  if (ratio > limits.maxCompressionRatio && compressed.length > 0) {
    if (audit) {
      entries.push({
        strategy: "whitespace", // attribute to pipeline, not a specific strategy
        original: `ratio=${(ratio * 100).toFixed(1)}%`,
        replacement: "compression aborted",
        reason: `safety limit: ratio ${(ratio * 100).toFixed(1)}% exceeds max ${(limits.maxCompressionRatio * 100).toFixed(1)}%`,
      });
    }
    return { text: original, limitTriggered: true };
  }

  // Min output chars check — output too short = return original
  if (compressed.length < limits.minOutputChars && original.length >= limits.minOutputChars) {
    if (audit) {
      entries.push({
        strategy: "whitespace",
        original: `output=${compressed.length} chars`,
        replacement: "compression aborted",
        reason: `safety limit: output ${compressed.length} chars below min ${limits.minOutputChars}`,
      });
    }
    return { text: original, limitTriggered: true };
  }

  return { text: compressed, limitTriggered: false };
}

/**
 * Compress text using rule-based strategies.
 *
 * @param input  Raw text to compress.
 * @param level  Compression aggressiveness. Default: "moderate".
 * @param options  Additional options (audit mode, per-strategy overrides).
 * @param configOverride  Optional CompressorConfig for exclusion patterns + safety limits.
 * @returns CompressResult with compressed text and optional audit report.
 */
export function compress(
  input: string,
  level: CompressionLevel = "moderate",
  options?: Omit<CompressOptions, "level">,
  configOverride?: Partial<CompressorConfig>
): CompressResult {
  if (!input) {
    return { compressed: "" };
  }

  const audit = options?.audit ?? false;
  const strategyOpts = options?.strategies;
  const allEntries: AuditEntry[] = [];

  // TC-2: Safety limit — truncate oversized input before processing
  const safetyLimits: SafetyLimits = {
    ...DEFAULT_SAFETY_LIMITS,
    ...(configOverride?.safetyLimits ?? {}),
  };

  let text = input;

  if (safetyLimits.maxInputChars > 0 && text.length > safetyLimits.maxInputChars) {
    const truncatedAt = safetyLimits.maxInputChars;
    text = text.slice(0, truncatedAt) + `\n[truncated: input exceeded ${truncatedAt} chars]`;
    if (audit) {
      allEntries.push({
        strategy: "whitespace",
        original: `input=${input.length} chars`,
        replacement: `truncated to ${truncatedAt} chars`,
        reason: "safety limit: max input chars exceeded",
      });
    }
  }

  // TC-2: Protect lines matching user-defined exclusion patterns
  const exclusionPatterns = configOverride?.exclusionPatterns ?? [];
  const compiledPatterns = compileExclusionPatterns(exclusionPatterns);
  const { text: protectedText, restorations } = protectExcludedLines(text, compiledPatterns);
  text = protectedText;

  for (const strategy of DEFAULT_STRATEGIES) {
    // Check if strategy is disabled via inline options
    const opts = strategyOpts?.[strategy.name as keyof NonNullable<typeof strategyOpts>];
    if (opts && opts.enabled === false) continue;

    // Check if strategy is disabled via config file
    const configStrats = configOverride?.strategies;
    if (configStrats) {
      const configOpt = configStrats[strategy.name as keyof typeof configStrats];
      if (configOpt && configOpt.enabled === false) continue;
    }

    const result = strategy.apply(text, audit, level);
    text = result.text;

    if (audit) {
      allEntries.push(...result.entries);
    }
  }

  // Restore excluded lines after all strategies have run
  text = restoreExcludedLines(text, restorations);

  // TC-2: Enforce safety limits on the compressed result
  const { text: safeText, limitTriggered } = enforceSafetyLimits(
    input,
    text,
    safetyLimits,
    audit,
    allEntries
  );

  if (limitTriggered) {
    // Safety limit triggered — return original with audit info only
    if (!audit) {
      return { compressed: safeText };
    }
    const ratio = 0; // No compression applied
    return {
      compressed: safeText,
      audit: { compressed: safeText, removed: allEntries, ratio },
    };
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
