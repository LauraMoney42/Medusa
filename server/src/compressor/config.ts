/**
 * TC-2: Compressor config loader.
 *
 * Loads user-facing config from ~/.claude-chat/compressor.json.
 * READ-ONLY — spec: "Config file MUST NOT be writable by tool itself."
 *
 * Falls back to defaults when file doesn't exist or is invalid.
 * Validates all fields strictly — bad config = fallback to defaults + warning.
 * Zero third-party deps (no Zod — manual validation to keep compressor dep-free).
 */

import fs from "fs";
import path from "path";
import type { CompressorConfig, CompressionLevel, SafetyLimits } from "./types.js";
import { DEFAULT_COMPRESSOR_CONFIG, DEFAULT_SAFETY_LIMITS } from "./types.js";

const VALID_LEVELS = new Set<string>(["conservative", "moderate", "aggressive"]);

/** Default config file path — user-visible, manually editable. */
const DEFAULT_CONFIG_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".claude-chat",
  "compressor.json"
);

/**
 * Validate and coerce raw JSON into a CompressorConfig.
 * Returns [config, warnings] — warnings are non-fatal validation issues.
 */
function validateConfig(raw: unknown): { config: CompressorConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config: CompressorConfig = { ...DEFAULT_COMPRESSOR_CONFIG };

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push("Config root must be an object — using defaults.");
    return { config, warnings };
  }

  const obj = raw as Record<string, unknown>;

  // Level
  if (obj.level !== undefined) {
    if (typeof obj.level === "string" && VALID_LEVELS.has(obj.level)) {
      config.level = obj.level as CompressionLevel;
    } else {
      warnings.push(`Invalid level "${String(obj.level)}" — using "${config.level}".`);
    }
  }

  // Exclusion patterns
  if (obj.exclusionPatterns !== undefined) {
    if (Array.isArray(obj.exclusionPatterns)) {
      const valid: string[] = [];
      for (const p of obj.exclusionPatterns) {
        if (typeof p !== "string") {
          warnings.push(`Exclusion pattern must be string, got ${typeof p} — skipping.`);
          continue;
        }
        // Validate regex syntax
        try {
          new RegExp(p);
          valid.push(p);
        } catch {
          warnings.push(`Invalid regex in exclusionPatterns: "${p}" — skipping.`);
        }
      }
      config.exclusionPatterns = valid;
    } else {
      warnings.push("exclusionPatterns must be an array — using empty list.");
    }
  }

  // Safety limits
  if (obj.safetyLimits !== undefined) {
    if (typeof obj.safetyLimits === "object" && obj.safetyLimits !== null) {
      const limits = obj.safetyLimits as Record<string, unknown>;
      config.safetyLimits = { ...DEFAULT_SAFETY_LIMITS };

      if (limits.maxCompressionRatio !== undefined) {
        const val = Number(limits.maxCompressionRatio);
        if (!isNaN(val) && val > 0 && val <= 1) {
          config.safetyLimits.maxCompressionRatio = val;
        } else {
          warnings.push(`maxCompressionRatio must be (0, 1] — using ${DEFAULT_SAFETY_LIMITS.maxCompressionRatio}.`);
        }
      }

      if (limits.minOutputChars !== undefined) {
        const val = Number(limits.minOutputChars);
        if (!isNaN(val) && val >= 0) {
          config.safetyLimits.minOutputChars = Math.floor(val);
        } else {
          warnings.push(`minOutputChars must be >= 0 — using ${DEFAULT_SAFETY_LIMITS.minOutputChars}.`);
        }
      }

      if (limits.maxInputChars !== undefined) {
        const val = Number(limits.maxInputChars);
        if (!isNaN(val) && val >= 0) {
          config.safetyLimits.maxInputChars = Math.floor(val);
        } else {
          warnings.push(`maxInputChars must be >= 0 — using ${DEFAULT_SAFETY_LIMITS.maxInputChars}.`);
        }
      }
    } else {
      warnings.push("safetyLimits must be an object — using defaults.");
    }
  }

  // Strategy overrides
  if (obj.strategies !== undefined) {
    if (typeof obj.strategies === "object" && obj.strategies !== null) {
      const strats = obj.strategies as Record<string, unknown>;

      for (const name of ["dedup", "whitespace", "boilerplate"] as const) {
        if (strats[name] !== undefined) {
          if (typeof strats[name] === "object" && strats[name] !== null) {
            const s = strats[name] as Record<string, unknown>;
            const target = config.strategies[name];

            if (s.enabled !== undefined) {
              target.enabled = Boolean(s.enabled);
            }

            // Strategy-specific fields
            if (name === "dedup" && s.minLength !== undefined) {
              const val = Number(s.minLength);
              if (!isNaN(val) && val >= 0) {
                (target as { enabled: boolean; minLength?: number }).minLength = Math.floor(val);
              }
            }
            if (name === "whitespace" && s.maxConsecutiveNewlines !== undefined) {
              const val = Number(s.maxConsecutiveNewlines);
              if (!isNaN(val) && val >= 0) {
                (target as { enabled: boolean; maxConsecutiveNewlines?: number }).maxConsecutiveNewlines = Math.floor(val);
              }
            }
            if (name === "boilerplate") {
              if (Array.isArray(s.extraPhrases)) {
                (target as { enabled: boolean; extraPhrases?: string[] }).extraPhrases =
                  s.extraPhrases.filter((p: unknown) => typeof p === "string");
              }
              if (Array.isArray(s.protectedPhrases)) {
                (target as { enabled: boolean; protectedPhrases?: string[] }).protectedPhrases =
                  s.protectedPhrases.filter((p: unknown) => typeof p === "string");
              }
            }
          } else {
            warnings.push(`strategies.${name} must be an object — using defaults.`);
          }
        }
      }
    } else {
      warnings.push("strategies must be an object — using defaults.");
    }
  }

  return { config, warnings };
}

/**
 * Load compressor config from a JSON file.
 *
 * @param configPath  Path to config file. Defaults to ~/.claude-chat/compressor.json.
 * @returns Validated config + any warnings logged to stderr.
 */
export function loadCompressorConfig(configPath?: string): CompressorConfig {
  const filePath = configPath || DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(filePath)) {
    // No config file — use defaults silently. This is the normal case.
    return { ...DEFAULT_COMPRESSOR_CONFIG };
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    raw = JSON.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[compressor-config] Failed to read ${filePath}: ${msg} — using defaults.\n`);
    return { ...DEFAULT_COMPRESSOR_CONFIG };
  }

  const { config, warnings } = validateConfig(raw);

  for (const w of warnings) {
    process.stderr.write(`[compressor-config] ${w}\n`);
  }

  return config;
}

/**
 * Compile exclusion patterns from config into RegExp objects.
 * Cached per config load — not recompiled per compress() call.
 */
export function compileExclusionPatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, "i"));
}

/**
 * Check if a line matches any user-defined exclusion pattern.
 * These lines are never compressed by any strategy.
 */
export function isExcluded(line: string, compiledPatterns: RegExp[]): boolean {
  return compiledPatterns.some((re) => re.test(line));
}

export { DEFAULT_CONFIG_PATH };
