import { describe, it, expect } from "vitest";
import { selectModel, NEXT_TIER, type ModelTier } from "../model-router.js";

describe("selectModel — overrides", () => {
  it("honors an explicit tier override regardless of source", () => {
    for (const tier of ["haiku", "sonnet", "opus", "fable"] as ModelTier[]) {
      expect(selectModel({ prompt: "architect a system", source: "user", modelOverride: tier })).toBe(tier);
    }
  });

  it("is case-insensitive on the override", () => {
    expect(selectModel({ prompt: "x", source: "user", modelOverride: "OPUS" })).toBe("opus");
  });

  it("falls back to sonnet for a full model-name override", () => {
    expect(selectModel({ prompt: "x", source: "user", modelOverride: "claude-3-5-sonnet-latest" })).toBe("sonnet");
  });
});

describe("selectModel — source routing", () => {
  it("routes poll and nudge sources to haiku", () => {
    expect(selectModel({ prompt: "anything", source: "poll" })).toBe("haiku");
    expect(selectModel({ prompt: "anything", source: "nudge" })).toBe("haiku");
  });

  it("routes short mentions to haiku and long mentions to sonnet", () => {
    expect(selectModel({ prompt: "ok thanks", source: "mention" })).toBe("haiku");
    expect(selectModel({ prompt: "x".repeat(250), source: "mention" })).toBe("sonnet");
  });
});

describe("selectModel — user prompt patterns", () => {
  it("escalates architecture/review prompts to opus", () => {
    expect(selectModel({ prompt: "Please architect the auth flow", source: "user" })).toBe("opus");
    expect(selectModel({ prompt: "do a security review of this", source: "user" })).toBe("opus");
    expect(selectModel({ prompt: "code review needed", source: "user" })).toBe("opus");
  });

  it("routes status/ack prompts to haiku", () => {
    expect(selectModel({ prompt: "[NO-ACTION] standing by", source: "user" })).toBe("haiku");
    expect(selectModel({ prompt: "just a status update", source: "user" })).toBe("haiku");
  });

  it("defaults ordinary user prompts to sonnet", () => {
    expect(selectModel({ prompt: "add a button to the settings page", source: "user" })).toBe("sonnet");
  });

  it("prefers haiku over opus when both patterns match (haiku checked first)", () => {
    expect(selectModel({ prompt: "status check before the code review", source: "user" })).toBe("haiku");
  });
});

describe("NEXT_TIER escalation map", () => {
  it("escalates haiku -> sonnet -> opus and caps at opus", () => {
    expect(NEXT_TIER.haiku).toBe("sonnet");
    expect(NEXT_TIER.sonnet).toBe("opus");
    expect(NEXT_TIER.opus).toBeNull();
  });

  it("falls fable back to sonnet", () => {
    expect(NEXT_TIER.fable).toBe("sonnet");
  });
});
