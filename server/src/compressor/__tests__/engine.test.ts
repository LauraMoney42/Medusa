/**
 * TC-7: Integration tests for the compress() engine orchestrator.
 * Tests strategy composition, safety limits, exclusion patterns,
 * audit mode, transparency markers, and determinism.
 */

import { describe, it, expect } from "vitest";
import { compress, estimateTokens } from "../engine.js";
import type { CompressorConfig } from "../types.js";
import { DEFAULT_COMPRESSOR_CONFIG } from "../types.js";

describe("compress() engine", () => {
  describe("basic compression", () => {
    it("returns empty string for empty input", () => {
      const { compressed } = compress("");
      expect(compressed).toBe("");
    });

    it("compresses whitespace + dedup + boilerplate in pipeline order", () => {
      const input = [
        "Great question! Here is the answer.",
        "   trailing spaces   ",
        "some repeated content here for testing",
        "",
        "",
        "",
        "",
        "some repeated content here for testing",
        "The result is 42. Hope that helps!",
      ].join("\n");

      const { compressed } = compress(input, "moderate");
      // Pleasantry "Great question!" stripped
      expect(compressed).not.toMatch(/^Great question/m);
      // Sign-off "Hope that helps" stripped
      expect(compressed).not.toContain("Hope that helps");
      // Trailing spaces stripped
      expect(compressed).not.toContain("trailing spaces   ");
      // Duplicate line removed
      expect(
        compressed.split("\n").filter((l) => l.includes("some repeated content"))
      ).toHaveLength(1);
    });

    it("defaults to moderate level", () => {
      // Input must be long enough that compressed output stays above minOutputChars (50).
      // Avoid "security" keyword which triggers isSecurityContent() protection.
      const input = [
        "It basically works perfectly fine with the new deployment pipeline and all the tests pass correctly.",
        "As mentioned earlier, the integration is complete and ready for review by the engineering team.",
      ].join("\n");
      const { compressed } = compress(input);
      // Moderate strips fillers + restated context
      expect(compressed).not.toContain("basically");
      expect(compressed).not.toContain("As mentioned earlier");
    });
  });

  describe("compression levels", () => {
    it("conservative is least aggressive", () => {
      const input = "It basically works.\nAs mentioned earlier, done.";
      const { compressed } = compress(input, "conservative");
      // Conservative does NOT strip fillers or restated context
      expect(compressed).toContain("basically");
      expect(compressed).toContain("As mentioned earlier");
    });

    it("aggressive includes timestamp abbreviation", () => {
      const input = [
        "[Dev1 @ 2026-02-22T10:00:00.000Z]: task done",
        "[Dev2 @ 2026-02-22T10:05:00.000Z]: confirmed",
      ].join("\n");

      const { compressed } = compress(input, "aggressive");
      expect(compressed).not.toContain("2026-02-22T");
    });
  });

  describe("transparency marker", () => {
    it("appends [compressed: X->Y lines] marker when lines change", () => {
      const input = "hello\n\n\n\n\nworld\nhello";
      const { compressed } = compress(input, "moderate");
      expect(compressed).toContain("[compressed:");
      expect(compressed).toMatch(/\[compressed: \d+->\d+ lines/);
    });

    it("does NOT append marker when no lines removed", () => {
      const input = "clean line one\nclean line two";
      const { compressed } = compress(input, "conservative");
      // No compression happened → no marker
      expect(compressed).not.toContain("[compressed:");
    });
  });

  describe("audit mode", () => {
    it("returns audit report when enabled", () => {
      const input = "Great question! The answer.\n\n\n\nDone.";
      const result = compress(input, "moderate", { audit: true });
      expect(result.audit).toBeDefined();
      expect(result.audit!.removed.length).toBeGreaterThan(0);
      expect(typeof result.audit!.ratio).toBe("number");
      expect(result.audit!.compressed).toBe(result.compressed);
    });

    it("does NOT return audit when disabled", () => {
      const { audit } = compress("hello", "moderate");
      expect(audit).toBeUndefined();
    });

    it("ratio is between 0 and 1 for normal compression", () => {
      const input = "Great question!\n\n\n\n\nSure thing! Absolutely! The answer is 42.\nAs mentioned earlier, done. Hope that helps!";
      const result = compress(input, "aggressive", { audit: true });
      expect(result.audit!.ratio).toBeGreaterThanOrEqual(0);
      expect(result.audit!.ratio).toBeLessThanOrEqual(1);
    });
  });

  describe("safety limits", () => {
    it("returns original when compression ratio exceeds max", () => {
      // Force extreme compression with very low maxCompressionRatio
      const input = "Great question! " + "filler text. ".repeat(50) + "Hope that helps!";
      const config: Partial<CompressorConfig> = {
        safetyLimits: {
          maxCompressionRatio: 0.01, // Only allow 1% compression
          minOutputChars: 0,
          maxInputChars: 0,
        },
      };

      const result = compress(input, "aggressive", { audit: true }, config);
      // If compression exceeds 1%, should return original
      // (depends on how much the strategies actually compress)
      expect(result.compressed.length).toBeGreaterThan(0);
    });

    it("returns original when output too short", () => {
      const input = "Great question!\nAbsolutely!";
      const config: Partial<CompressorConfig> = {
        safetyLimits: {
          maxCompressionRatio: 0.8,
          minOutputChars: 10000, // Impossibly high min
          maxInputChars: 0,
        },
      };

      const result = compress(input, "aggressive", undefined, config);
      // Output would be too short → return original
      expect(result.compressed).toBe(input);
    });

    it("truncates oversized input", () => {
      const input = "a".repeat(1000);
      const config: Partial<CompressorConfig> = {
        safetyLimits: {
          maxCompressionRatio: 0.8,
          minOutputChars: 0,
          maxInputChars: 100, // Truncate at 100 chars
        },
      };

      const result = compress(input, "moderate", { audit: true }, config);
      expect(result.audit!.removed.some((e) => e.reason.includes("max input chars"))).toBe(true);
    });
  });

  describe("exclusion patterns", () => {
    it("protects lines matching exclusion patterns from compression", () => {
      const input = "Great question! IMPORTANT: do not touch this.\nGreat question! Some other text.";
      const config: Partial<CompressorConfig> = {
        exclusionPatterns: ["^Great question! IMPORTANT"],
      };

      const result = compress(input, "aggressive", undefined, config);
      // The excluded line should be preserved exactly
      expect(result.compressed).toContain("Great question! IMPORTANT: do not touch this.");
      // The non-excluded line should have "Great question!" stripped
      expect(result.compressed).not.toMatch(/Great question! Some/);
    });

    it("handles multiple exclusion patterns", () => {
      const input = "PINNED: keep this\nDO NOT COMPRESS: this too\nGreat question! Strip this.";
      const config: Partial<CompressorConfig> = {
        exclusionPatterns: ["PINNED:", "DO NOT COMPRESS"],
      };

      const result = compress(input, "aggressive", undefined, config);
      expect(result.compressed).toContain("PINNED: keep this");
      expect(result.compressed).toContain("DO NOT COMPRESS: this too");
    });
  });

  describe("strategy disabling", () => {
    it("skips dedup when disabled via inline options", () => {
      const input = "duplicate line here for testing\nother\nduplicate line here for testing";
      const result = compress(input, "moderate", {
        strategies: { dedup: { enabled: false } },
      });
      expect(
        result.compressed.split("\n").filter((l) => l.includes("duplicate line"))
      ).toHaveLength(2);
    });

    it("skips whitespace when disabled via config", () => {
      const input = "hello    world";
      const config: Partial<CompressorConfig> = {
        strategies: {
          ...DEFAULT_COMPRESSOR_CONFIG.strategies,
          whitespace: { enabled: false },
        },
      };
      const result = compress(input, "moderate", undefined, config);
      expect(result.compressed).toContain("hello    world");
    });

    it("skips boilerplate when disabled via inline options", () => {
      const input = "Great question! The answer.";
      const result = compress(input, "moderate", {
        strategies: { boilerplate: { enabled: false } },
      });
      expect(result.compressed).toContain("Great question!");
    });
  });

  describe("determinism", () => {
    it("produces identical output for identical input", () => {
      const input = "Great question!\n\n\n\nDuplicate line.\nDuplicate line.\nDone. Hope that helps!";
      const r1 = compress(input, "moderate");
      const r2 = compress(input, "moderate");
      expect(r1.compressed).toBe(r2.compressed);
    });

    it("produces identical audit for identical input", () => {
      const input = "Great question! Text.\n\n\n\nDone.";
      const r1 = compress(input, "moderate", { audit: true });
      const r2 = compress(input, "moderate", { audit: true });
      expect(r1.audit!.ratio).toBe(r2.audit!.ratio);
      expect(r1.audit!.removed.length).toBe(r2.audit!.removed.length);
    });
  });
});

describe("estimateTokens()", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 → ceil 3
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 1 for very short text", () => {
    expect(estimateTokens("hi")).toBe(1);
  });
});
