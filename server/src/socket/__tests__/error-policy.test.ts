import { describe, it, expect } from "vitest";
import {
  isAuthError,
  ConsecutiveErrorDeduper,
  buildAllTiersFailedMessage,
} from "../error-policy.js";

describe("isAuthError", () => {
  it("detects the 'Not logged in' message", () => {
    expect(isAuthError("Not logged in · Please run /login")).toBe(true);
  });

  it("detects a message that only mentions /login", () => {
    expect(isAuthError("Run /login to continue")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isAuthError("NOT LOGGED IN")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isAuthError("Prompt is too long")).toBe(false);
    expect(isAuthError("exceeded model token limit")).toBe(false);
  });
});

describe("ConsecutiveErrorDeduper", () => {
  it("emits the first message it sees", () => {
    const deduper = new ConsecutiveErrorDeduper();
    expect(deduper.shouldEmit("Not logged in")).toBe(true);
  });

  it("suppresses an immediate repeat of the same message", () => {
    const deduper = new ConsecutiveErrorDeduper();
    deduper.shouldEmit("Not logged in");
    expect(deduper.shouldEmit("Not logged in")).toBe(false);
    expect(deduper.shouldEmit("Not logged in")).toBe(false);
  });

  it("emits again once the message changes, then suppresses repeats of the new one", () => {
    const deduper = new ConsecutiveErrorDeduper();
    deduper.shouldEmit("Not logged in");
    expect(deduper.shouldEmit("Prompt is too long")).toBe(true);
    expect(deduper.shouldEmit("Prompt is too long")).toBe(false);
  });

  it("emits again if the same message reappears after a different one interrupts it", () => {
    const deduper = new ConsecutiveErrorDeduper();
    deduper.shouldEmit("A");
    deduper.shouldEmit("B");
    expect(deduper.shouldEmit("A")).toBe(true);
  });

  it("tracks the last message seen", () => {
    const deduper = new ConsecutiveErrorDeduper();
    expect(deduper.getLast()).toBeNull();
    deduper.shouldEmit("Not logged in");
    expect(deduper.getLast()).toBe("Not logged in");
  });
});

describe("buildAllTiersFailedMessage", () => {
  it("includes a plain login command when no config dir is set", () => {
    const msg = buildAllTiersFailedMessage("Not logged in · Please run /login");
    expect(msg).toContain("All models failed:");
    expect(msg).toContain("claude /login");
    expect(msg).not.toContain("CLAUDE_CONFIG_DIR=");
  });

  it("includes CLAUDE_CONFIG_DIR when a custom config dir is active", () => {
    const msg = buildAllTiersFailedMessage("Not logged in", "/Users/me/.claude-account2");
    expect(msg).toContain("CLAUDE_CONFIG_DIR=/Users/me/.claude-account2 claude /login");
  });
});
