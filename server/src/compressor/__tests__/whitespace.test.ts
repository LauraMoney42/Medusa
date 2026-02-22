/**
 * TC-7: Unit tests for WhitespaceStrategy.
 * Tests whitespace normalization, code block preservation, and level-specific behavior.
 */

import { describe, it, expect } from "vitest";
import { WhitespaceStrategy } from "../strategies/whitespace.js";
import type { CompressionLevel } from "../types.js";

const strategy = new WhitespaceStrategy();

function apply(input: string, level: CompressionLevel = "moderate", audit = false) {
  return strategy.apply(input, audit, level);
}

describe("WhitespaceStrategy", () => {
  it("has correct name", () => {
    expect(strategy.name).toBe("whitespace");
  });

  describe("trailing whitespace", () => {
    it("strips trailing spaces from lines", () => {
      const { text } = apply("hello   \nworld  \n");
      expect(text).toBe("hello\nworld\n");
    });

    it("strips trailing tabs from lines", () => {
      const { text } = apply("hello\t\t\nworld\t\n");
      expect(text).toBe("hello\nworld\n");
    });

    it("preserves leading indentation", () => {
      const { text } = apply("  indented\n    deep\n");
      expect(text).toBe("  indented\n    deep\n");
    });
  });

  describe("excessive blank lines", () => {
    // MAX_NEWLINES config: conservative=2, moderate=1, aggressive=1
    // The regex replaces N+ consecutive \n with maxNewlines \n chars.

    it("collapses to maxNewlines(1) consecutive newlines in moderate mode", () => {
      const { text } = apply("hello\n\n\n\n\nworld", "moderate");
      // 5 \n → 1 \n (maxNewlines=1)
      expect(text).toBe("hello\nworld");
    });

    it("collapses to maxNewlines(2) consecutive newlines in conservative mode", () => {
      const { text } = apply("hello\n\n\n\n\nworld", "conservative");
      // 5 \n → 2 \n (maxNewlines=2)
      expect(text).toBe("hello\n\nworld");
    });

    it("collapses to maxNewlines(1) consecutive newlines in aggressive mode", () => {
      const { text } = apply("hello\n\n\n\n\nworld", "aggressive");
      // 5 \n → 1 \n (maxNewlines=1)
      expect(text).toBe("hello\nworld");
    });

    it("does not collapse single newline in moderate", () => {
      const { text } = apply("hello\nworld", "moderate");
      expect(text).toBe("hello\nworld");
    });

    it("collapses double newline in moderate (2 >= threshold 2)", () => {
      const { text } = apply("hello\n\nworld", "moderate");
      // moderate: maxNewlines=1, threshold=2, so \n\n matches and becomes \n
      expect(text).toBe("hello\nworld");
    });

    it("preserves double newline in conservative (2 < threshold 3)", () => {
      const { text } = apply("hello\n\nworld", "conservative");
      // conservative: maxNewlines=2, threshold=3, so \n\n does NOT match
      expect(text).toBe("hello\n\nworld");
    });
  });

  describe("inline multi-space collapse", () => {
    it("collapses multiple inline spaces to one", () => {
      const { text } = apply("hello    world");
      expect(text).toBe("hello world");
    });

    it("preserves leading indentation while collapsing inline", () => {
      const { text } = apply("    hello    world");
      expect(text).toBe("    hello world");
    });

    it("collapses tabs in non-leading portion", () => {
      const { text } = apply("hello\t\tworld");
      expect(text).toBe("hello world");
    });
  });

  describe("code block preservation", () => {
    it("does not modify content inside fenced code blocks", () => {
      const input = "text before\n```\n  code   with   spaces  \n\n\n\n  more  code\n```\ntext after";
      const { text } = apply(input, "aggressive");
      // Code block content should be preserved exactly
      expect(text).toContain("  code   with   spaces  ");
      expect(text).toContain("  more  code");
    });

    it("handles multiple code blocks", () => {
      const input = "a\n```\ncode1   here\n```\nb\n```\ncode2   here\n```\nc";
      const { text } = apply(input, "aggressive");
      expect(text).toContain("code1   here");
      expect(text).toContain("code2   here");
    });

    it("normalizes text between code blocks", () => {
      const input = "hello    world\n```\ncode\n```\ngoodbye    world";
      const { text } = apply(input);
      expect(text).toContain("hello world");
      expect(text).toContain("goodbye world");
    });
  });

  describe("audit mode", () => {
    it("returns audit entries for trailing whitespace", () => {
      const { entries } = apply("hello   ", "moderate", true);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((e) => e.reason === "trailing whitespace")).toBe(true);
      expect(entries[0].strategy).toBe("whitespace");
    });

    it("returns audit entries for blank line collapse", () => {
      const { entries } = apply("a\n\n\n\nb", "moderate", true);
      expect(entries.some((e) => e.reason === "excessive blank lines")).toBe(true);
    });

    it("returns audit entries for inline collapse", () => {
      const { entries } = apply("hello    world", "moderate", true);
      expect(entries.some((e) => e.reason === "inline multi-space collapse")).toBe(true);
    });

    it("returns no entries when nothing to compress", () => {
      const { entries } = apply("clean text\nno extras", "moderate", true);
      expect(entries).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("handles empty input", () => {
      const { text } = apply("");
      expect(text).toBe("");
    });

    it("handles single newline", () => {
      const { text } = apply("\n");
      expect(text).toBe("\n");
    });

    it("handles already clean text", () => {
      const clean = "hello world\nfoo bar";
      const { text } = apply(clean);
      expect(text).toBe(clean);
    });

    it("handles text that is all whitespace", () => {
      const { text } = apply("   \n   \n   ");
      // Trailing whitespace stripped → "\n\n", then \n{2,} collapsed to \n (moderate maxNewlines=1)
      expect(text).toBe("\n");
    });
  });
});
