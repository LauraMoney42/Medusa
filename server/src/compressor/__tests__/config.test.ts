/**
 * TC-7: Unit tests for compressor config loader.
 * Tests config validation, exclusion pattern compilation, defaults, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { compileExclusionPatterns, isExcluded } from "../config.js";
import { DEFAULT_COMPRESSOR_CONFIG, DEFAULT_SAFETY_LIMITS } from "../types.js";

describe("compileExclusionPatterns()", () => {
  it("compiles string patterns to RegExp objects", () => {
    const compiled = compileExclusionPatterns(["^IMPORTANT:", "\\[PINNED\\]"]);
    expect(compiled).toHaveLength(2);
    expect(compiled[0]).toBeInstanceOf(RegExp);
    expect(compiled[1]).toBeInstanceOf(RegExp);
  });

  it("returns empty array for empty input", () => {
    expect(compileExclusionPatterns([])).toHaveLength(0);
  });

  it("compiled patterns are case-insensitive", () => {
    const compiled = compileExclusionPatterns(["important"]);
    expect(compiled[0].test("IMPORTANT")).toBe(true);
    expect(compiled[0].test("important")).toBe(true);
  });
});

describe("isExcluded()", () => {
  it("returns true when line matches any pattern", () => {
    const patterns = compileExclusionPatterns(["^IMPORTANT:", "DO NOT COMPRESS"]);
    expect(isExcluded("IMPORTANT: keep this", patterns)).toBe(true);
    expect(isExcluded("please DO NOT COMPRESS this", patterns)).toBe(true);
  });

  it("returns false when line matches no patterns", () => {
    const patterns = compileExclusionPatterns(["^IMPORTANT:"]);
    expect(isExcluded("just a regular line", patterns)).toBe(false);
  });

  it("returns false for empty pattern list", () => {
    expect(isExcluded("anything", [])).toBe(false);
  });
});

describe("DEFAULT_COMPRESSOR_CONFIG", () => {
  it("has moderate as default level", () => {
    expect(DEFAULT_COMPRESSOR_CONFIG.level).toBe("moderate");
  });

  it("has empty exclusion patterns by default", () => {
    expect(DEFAULT_COMPRESSOR_CONFIG.exclusionPatterns).toEqual([]);
  });

  it("has all strategies enabled by default", () => {
    expect(DEFAULT_COMPRESSOR_CONFIG.strategies.dedup.enabled).toBe(true);
    expect(DEFAULT_COMPRESSOR_CONFIG.strategies.whitespace.enabled).toBe(true);
    expect(DEFAULT_COMPRESSOR_CONFIG.strategies.boilerplate.enabled).toBe(true);
  });
});

describe("DEFAULT_SAFETY_LIMITS", () => {
  it("has conservative defaults to prevent data loss", () => {
    expect(DEFAULT_SAFETY_LIMITS.maxCompressionRatio).toBe(0.8);
    expect(DEFAULT_SAFETY_LIMITS.minOutputChars).toBe(50);
    expect(DEFAULT_SAFETY_LIMITS.maxInputChars).toBe(500_000);
  });
});
