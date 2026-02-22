/**
 * TC-7: Unit tests for BoilerplateStrategy.
 * Tests pleasantry removal, sign-offs, filler phrases, ack dedup,
 * timestamp abbreviation, level gating, and security preservation.
 */

import { describe, it, expect } from "vitest";
import { BoilerplateStrategy } from "../strategies/boilerplate.js";
import type { CompressionLevel } from "../types.js";

const strategy = new BoilerplateStrategy();

function apply(input: string, level: CompressionLevel = "moderate", audit = false) {
  return strategy.apply(input, audit, level);
}

describe("BoilerplateStrategy", () => {
  it("has correct name", () => {
    expect(strategy.name).toBe("boilerplate");
  });

  describe("pleasantries (all levels)", () => {
    const pleasantries = [
      "Great question! Here is the answer.",
      "Absolutely! I can do that.",
      "Thanks for the update! Moving on.",
      "Happy to help. Here's the info.",
      "Sure thing! Let me check.",
      "Of course! Here you go.",
      "That's a great point! Let me address it.",
      "Good catch! Fixed now.",
      "No problem! Done.",
      "Great work! Continuing.",
      "Sounds good! On it.",
      "Perfect! Next step.",
    ];

    for (const phrase of pleasantries) {
      it(`strips "${phrase.slice(0, 30)}..."`, () => {
        const { text } = apply(phrase, "conservative");
        // The pleasantry prefix should be removed; the rest should remain
        expect(text).not.toMatch(/^(Great question|Absolutely|Thanks for the update|Happy to help|Sure thing|Of course|That's a great point|Good catch|No problem|Great work|Sounds good|Perfect)/i);
      });
    }
  });

  describe("sign-offs (all levels)", () => {
    const signoffs = [
      "Result is 42. Let me know if you need anything else!",
      "Done. Feel free to ask!",
      "Shipped. Hope that helps!",
      "Fixed. Don't hesitate to reach out!",
      "Complete. Let me know if you have any questions!",
      "Ready. I'm here if you need me!",
    ];

    for (const phrase of signoffs) {
      it(`strips sign-off from "${phrase.slice(0, 35)}..."`, () => {
        const { text } = apply(phrase, "conservative");
        expect(text).not.toMatch(/Let me know|Feel free|Hope that helps|Don't hesitate|I'm here if/i);
      });
    }
  });

  describe("restated context (moderate+)", () => {
    it("strips 'As mentioned earlier' in moderate", () => {
      const { text } = apply("As mentioned earlier, the fix is in place.", "moderate");
      expect(text.trim()).toBe("the fix is in place.");
    });

    it("does NOT strip 'As mentioned earlier' in conservative", () => {
      const { text } = apply("As mentioned earlier, the fix is in place.", "conservative");
      expect(text).toContain("As mentioned earlier");
    });

    it("strips 'As previously discussed'", () => {
      const { text } = apply("As previously discussed, we ship today.", "moderate");
      expect(text.trim()).toBe("we ship today.");
    });

    it("strips 'Like I mentioned'", () => {
      const { text } = apply("Like I mentioned, it works now.", "moderate");
      expect(text.trim()).toBe("it works now.");
    });
  });

  describe("filler phrases (moderate+)", () => {
    it("strips 'basically' inline", () => {
      const { text } = apply("It basically works fine.", "moderate");
      expect(text.trim()).toBe("It works fine.");
    });

    it("strips 'essentially' inline", () => {
      const { text } = apply("It essentially does the same thing.", "moderate");
      expect(text.trim()).toBe("It does the same thing.");
    });

    it("strips 'it's worth noting that'", () => {
      const { text } = apply("It's worth noting that the test passes.", "moderate");
      expect(text.trim()).toBe("the test passes.");
    });

    it("does NOT strip fillers in conservative", () => {
      const { text } = apply("It basically works fine.", "conservative");
      expect(text).toContain("basically");
    });
  });

  describe("ack dedup (moderate+)", () => {
    it("keeps first ack, removes subsequent identical acks", () => {
      const input = "Acknowledged.\nSome work done.\nAcknowledged.";
      const { text } = apply(input, "moderate");
      expect(text.split("\n").filter((l) => l.trim().toLowerCase() === "acknowledged.")).toHaveLength(1);
    });

    it("keeps different ack types", () => {
      const input = "Acknowledged.\nConfirmed.\nOn it.";
      const { text } = apply(input, "moderate");
      // All three are different ack types — all should remain
      expect(text.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(3);
    });

    it("does NOT dedup acks in conservative", () => {
      const input = "Acknowledged.\nSome text.\nAcknowledged.";
      const { text } = apply(input, "conservative");
      expect(text.split("\n").filter((l) => l.trim().toLowerCase() === "acknowledged.")).toHaveLength(2);
    });
  });

  describe("timestamp abbreviation (aggressive only)", () => {
    it("abbreviates same-day timestamps to HH:MM", () => {
      const input = [
        "[Dev1 @ 2026-02-22T10:00:00.000Z]: msg one",
        "[Dev2 @ 2026-02-22T10:05:00.000Z]: msg two",
      ].join("\n");

      const { text } = apply(input, "aggressive");
      expect(text).toContain("10:00");
      expect(text).toContain("10:05");
      expect(text).not.toContain("2026-02-22T");
    });

    it("does NOT abbreviate when timestamps span multiple days", () => {
      const input = [
        "[Dev1 @ 2026-02-21T10:00:00.000Z]: msg one",
        "[Dev2 @ 2026-02-22T10:05:00.000Z]: msg two",
      ].join("\n");

      const { text } = apply(input, "aggressive");
      expect(text).toContain("2026-02-21T");
      expect(text).toContain("2026-02-22T");
    });

    it("does NOT abbreviate timestamps in moderate", () => {
      const input = "[Dev1 @ 2026-02-22T10:00:00.000Z]: msg";
      const { text } = apply(input, "moderate");
      expect(text).toContain("2026-02-22T");
    });
  });

  describe("security content preservation", () => {
    it("does NOT strip pleasantries from security lines", () => {
      const input = "Great question! 🚨 APPROVAL NEEDED: verify this";
      const { text } = apply(input, "aggressive");
      expect(text).toContain("Great question");
      expect(text).toContain("APPROVAL NEEDED");
    });

    it("does NOT strip sign-offs from security lines", () => {
      const input = "CRITICAL security issue detected. Let me know if you need anything else!";
      const { text } = apply(input, "aggressive");
      expect(text).toContain("Let me know");
    });
  });

  describe("audit mode", () => {
    it("records pleasantry removals", () => {
      const { entries } = apply("Great question! The answer is yes.", "moderate", true);
      expect(entries.some((e) => e.reason === "pleasantry")).toBe(true);
      expect(entries[0].strategy).toBe("boilerplate");
    });

    it("records sign-off removals", () => {
      const { entries } = apply("Done. Hope that helps!", "moderate", true);
      expect(entries.some((e) => e.reason === "sign-off")).toBe(true);
    });

    it("records ack dedup removals", () => {
      const input = "Acknowledged.\nText.\nAcknowledged.";
      const { entries } = apply(input, "moderate", true);
      expect(entries.some((e) => e.reason === "redundant ack")).toBe(true);
    });

    it("records timestamp abbreviations", () => {
      const input = "[Dev1 @ 2026-02-22T10:00:00.000Z]: msg";
      const { entries } = apply(input, "aggressive", true);
      expect(entries.some((e) => e.reason === "timestamp abbreviation (same-day)")).toBe(true);
    });
  });

  describe("empty line cleanup", () => {
    it("removes lines that became whitespace-only after stripping", () => {
      // A line that is ONLY a pleasantry should be removed entirely
      const input = "Great question!\nThe answer is 42.";
      const { text } = apply(input, "moderate");
      // "Great question!" line stripped to empty → removed
      expect(text.trim()).toBe("The answer is 42.");
    });
  });

  describe("edge cases", () => {
    it("handles empty input", () => {
      const { text } = apply("");
      expect(text).toBe("");
    });

    it("handles input with no boilerplate", () => {
      const clean = "Deploy to staging.\nRun integration tests.\nVerify metrics.";
      const { text } = apply(clean, "aggressive");
      expect(text).toContain("Deploy to staging");
      expect(text).toContain("Run integration tests");
      expect(text).toContain("Verify metrics");
    });
  });
});
