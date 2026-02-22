/**
 * TC-7: Unit tests for DedupStrategy.
 * Tests hub message dedup, repeated line dedup, and security content preservation.
 */

import { describe, it, expect } from "vitest";
import { DedupStrategy } from "../strategies/dedup.js";
import type { CompressionLevel } from "../types.js";

const strategy = new DedupStrategy();

function apply(input: string, level: CompressionLevel = "moderate", audit = false) {
  return strategy.apply(input, audit, level);
}

describe("DedupStrategy", () => {
  it("has correct name", () => {
    expect(strategy.name).toBe("dedup");
  });

  describe("hub message deduplication", () => {
    it("removes earlier duplicate hub messages, keeps last", () => {
      const input = [
        "[Dev1 @ 2026-02-22T10:00:00.000Z]: hello world",
        "[Dev2 @ 2026-02-22T10:01:00.000Z]: some other msg",
        "[Dev1 @ 2026-02-22T10:05:00.000Z]: hello world",
      ].join("\n");

      const { text } = apply(input);
      const lines = text.split("\n");
      // Should keep only the last occurrence of Dev1's "hello world"
      expect(lines.filter((l) => l.includes("hello world"))).toHaveLength(1);
      expect(lines[lines.length - 1]).toContain("10:05:00");
    });

    it("does not dedup messages with different text", () => {
      const input = [
        "[Dev1 @ 2026-02-22T10:00:00.000Z]: message one",
        "[Dev1 @ 2026-02-22T10:05:00.000Z]: message two",
      ].join("\n");

      const { text } = apply(input);
      expect(text.split("\n")).toHaveLength(2);
    });

    it("does not dedup messages from different senders", () => {
      const input = [
        "[Dev1 @ 2026-02-22T10:00:00.000Z]: same text",
        "[Dev2 @ 2026-02-22T10:01:00.000Z]: same text",
      ].join("\n");

      const { text } = apply(input);
      expect(text.split("\n")).toHaveLength(2);
    });

    it("preserves security-content hub messages even if duplicated", () => {
      const input = [
        "[Security @ 2026-02-22T10:00:00.000Z]: APPROVAL NEEDED: review this",
        "[Dev1 @ 2026-02-22T10:01:00.000Z]: some msg",
        "[Security @ 2026-02-22T10:05:00.000Z]: APPROVAL NEEDED: review this",
      ].join("\n");

      const { text } = apply(input);
      // Both security messages should be preserved
      expect(text.split("\n").filter((l) => l.includes("APPROVAL NEEDED"))).toHaveLength(2);
    });
  });

  describe("repeated line deduplication", () => {
    it("removes exact duplicate lines (keeps first)", () => {
      // Lines must be >= minLength (moderate=10) to be dedup candidates
      const input = "this is a duplicate line\nsome other content\nthis is a duplicate line\nfinal line here";
      const { text } = apply(input);
      expect(text.split("\n").filter((l) => l.includes("this is a duplicate"))).toHaveLength(1);
    });

    it("is case-insensitive", () => {
      const input = "Hello World\nSomething\nhello world";
      const { text } = apply(input);
      expect(text.split("\n")).toHaveLength(2);
    });

    it("respects minLength by level - conservative (20)", () => {
      const shortLine = "short line"; // 10 chars
      const input = `${shortLine}\nother\n${shortLine}`;
      // Conservative: minLength=20, so short lines should NOT be deduped
      const { text } = apply(input, "conservative");
      expect(text.split("\n").filter((l) => l === shortLine)).toHaveLength(2);
    });

    it("respects minLength by level - aggressive (5)", () => {
      const shortLine = "short line"; // 10 chars, > 5
      const input = `${shortLine}\nother\n${shortLine}`;
      const { text } = apply(input, "aggressive");
      expect(text.split("\n").filter((l) => l === shortLine)).toHaveLength(1);
    });

    it("always preserves empty lines", () => {
      const input = "a\n\nb\n\nc";
      const { text } = apply(input);
      expect(text).toBe("a\n\nb\n\nc");
    });

    it("preserves security-content lines even if duplicated", () => {
      const input = "🚨 CRITICAL alert\nsome text\n🚨 CRITICAL alert";
      const { text } = apply(input);
      expect(text.split("\n").filter((l) => l.includes("CRITICAL"))).toHaveLength(2);
    });
  });

  describe("audit mode", () => {
    it("records hub message dedup entries", () => {
      const input = [
        "[Dev1 @ 2026-02-22T10:00:00.000Z]: hello",
        "[Dev1 @ 2026-02-22T10:05:00.000Z]: hello",
      ].join("\n");

      const { entries } = apply(input, "moderate", true);
      expect(entries.some((e) => e.reason === "duplicate hub message")).toBe(true);
      expect(entries[0].strategy).toBe("dedup");
    });

    it("records repeated line dedup entries", () => {
      const input = "this is a long enough line to dedup\nother\nthis is a long enough line to dedup";
      const { entries } = apply(input, "moderate", true);
      expect(entries.some((e) => e.reason === "duplicate line")).toBe(true);
    });

    it("returns no entries for unique content", () => {
      const input = "line one\nline two\nline three";
      const { entries } = apply(input, "moderate", true);
      expect(entries).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("handles empty input", () => {
      const { text } = apply("");
      expect(text).toBe("");
    });

    it("handles single line", () => {
      const { text } = apply("just one line");
      expect(text).toBe("just one line");
    });

    it("handles all duplicate lines", () => {
      const line = "this line repeats many times here";
      const input = Array(5).fill(line).join("\n");
      const { text } = apply(input);
      expect(text.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
    });
  });
});
