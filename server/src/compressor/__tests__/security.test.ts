/**
 * TC-7: Security content protection tests.
 * Validates that security-relevant content is NEVER stripped by any strategy.
 * Per spec: "Tool MUST NOT strip security-relevant content"
 */

import { describe, it, expect } from "vitest";
import { isSecurityContent } from "../types.js";
import { compress } from "../engine.js";

describe("isSecurityContent()", () => {
  const securityTerms = [
    "APPROVAL NEEDED: review this change",
    "security vulnerability detected",
    "escalation required immediately",
    "auth warning: token expired",
    "access blocked by firewall",
    "request denied by policy",
    "verdict: safe to proceed",
    "CRITICAL system failure",
    "🚨 alert: unauthorized access",
    "permission denied for user",
    "unauthorized request from IP",
    "forbidden: insufficient privileges",
    "API_KEY exposed in logs",
    "SECRET value leaked",
    "TOKEN rotation required",
    "PRIVATE_KEY must not be shared",
  ];

  for (const term of securityTerms) {
    it(`detects security content: "${term.slice(0, 40)}..."`, () => {
      expect(isSecurityContent(term)).toBe(true);
    });
  }

  it("returns false for non-security content", () => {
    expect(isSecurityContent("just a regular message")).toBe(false);
    expect(isSecurityContent("deploy to staging")).toBe(false);
    expect(isSecurityContent("build successful")).toBe(false);
  });
});

describe("security content protection through full pipeline", () => {
  it("preserves security lines even with aggressive compression", () => {
    const input = [
      "Great question! The answer is yes.",
      "🚨 APPROVAL NEEDED: deploy to production",
      "Great question! Another pleasantry.",
      "CRITICAL: database migration failed",
      "Hope that helps!",
    ].join("\n");

    const { compressed } = compress(input, "aggressive");
    // Security lines MUST survive all strategies
    expect(compressed).toContain("APPROVAL NEEDED: deploy to production");
    expect(compressed).toContain("CRITICAL: database migration failed");
  });

  it("preserves duplicate security hub messages (dedup doesn't strip them)", () => {
    const input = [
      "[Security @ 2026-02-22T10:00:00.000Z]: 🚨 CRITICAL: breach detected",
      "[Dev1 @ 2026-02-22T10:01:00.000Z]: acknowledged",
      "[Security @ 2026-02-22T10:05:00.000Z]: 🚨 CRITICAL: breach detected",
    ].join("\n");

    const { compressed } = compress(input, "aggressive");
    // Both security messages should survive dedup
    const securityLines = compressed.split("\n").filter((l) => l.includes("CRITICAL: breach"));
    expect(securityLines.length).toBe(2);
  });

  it("preserves security content even when it contains boilerplate patterns", () => {
    const input = "Great question! 🚨 APPROVAL NEEDED: is this safe? Let me know if you need anything else!";
    const { compressed } = compress(input, "aggressive");
    // The whole line is security content — nothing should be stripped
    expect(compressed).toContain("Great question!");
    expect(compressed).toContain("APPROVAL NEEDED");
    expect(compressed).toContain("Let me know");
  });

  it("preserves security lines matching exclusion pattern format", () => {
    const input = [
      "auth warning: suspicious login attempt from unknown IP",
      "regular line that should compress normally",
      "permission denied for service account",
    ].join("\n");

    const { compressed } = compress(input, "aggressive");
    expect(compressed).toContain("auth warning");
    expect(compressed).toContain("permission denied");
  });

  it("security content protection is case-insensitive", () => {
    expect(isSecurityContent("Security review needed")).toBe(true);
    expect(isSecurityContent("SECURITY review needed")).toBe(true);
    expect(isSecurityContent("Escalation in progress")).toBe(true);
  });

  it("audit mode documents what was preserved (by not removing security lines)", () => {
    const input = [
      "Great question! Regular text.",
      "🚨 CRITICAL: important alert",
      "Great question! More regular text.",
    ].join("\n");

    const result = compress(input, "aggressive", { audit: true });
    // Only non-security "Great question!" should be in removed entries
    const removed = result.audit!.removed.filter((e) => e.reason === "pleasantry");
    // The security line's "Great question!" should NOT appear in removed
    for (const entry of removed) {
      expect(entry.original).not.toContain("CRITICAL");
    }
  });
});
