import { describe, it, expect } from "vitest";
import type { TokenUsageEntry } from "../token-logger.js";
import { TokenLogger } from "../token-logger.js";
import os from "os";
import path from "path";
import fs from "fs";

function entry(overrides: Partial<TokenUsageEntry>): TokenUsageEntry {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "s1",
    sessionTitle: "Test Session",
    claudeSessionId: "c1",
    messageId: "m1",
    source: "user",
    costUsd: 0.01,
    durationMs: 100,
    success: true,
    ...overrides,
  };
}

describe("TokenLogger: byModel aggregation", () => {
  it("groups by <provider>/<model> when both are known", () => {
    const logger = new TokenLogger(path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`));
    const summary = logger.summarize([
      entry({ provider: "openrouter", model: "openai/gpt-5.1", costUsd: 0.05 }),
      entry({ provider: "openrouter", model: "openai/gpt-5.1", costUsd: 0.03 }),
      entry({ provider: "claude", model: "sonnet", costUsd: 0.02 }),
    ]);

    expect(summary.byModel["openrouter/openai/gpt-5.1"]).toEqual({ costUsd: 0.08, messages: 2, priceKnown: false });
    expect(summary.byModel["claude/sonnet"]).toEqual({ costUsd: 0.02, messages: 1, priceKnown: true });
  });

  it("falls back to model-only or provider-only keys, and 'unknown' when neither is set", () => {
    const logger = new TokenLogger(path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`));
    const summary = logger.summarize([
      entry({ model: "sonnet" }),
      entry({ provider: "kimi" }),
      entry({}),
    ]);

    expect(summary.byModel["sonnet"]).toEqual({ costUsd: 0.01, messages: 1, priceKnown: true });
    expect(summary.byModel["kimi"]).toEqual({ costUsd: 0.01, messages: 1, priceKnown: true });
    expect(summary.byModel["unknown"]).toEqual({ costUsd: 0.01, messages: 1, priceKnown: true });
  });

  it("flags an OpenRouter model with no known pricing as priceKnown: false and costUsd 0", () => {
    const logger = new TokenLogger(path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`));
    const summary = logger.summarize([
      entry({ provider: "openrouter", model: "some/unpriced-model", costUsd: 0.5, inputTokens: 100, outputTokens: 50 }),
    ]);

    expect(summary.byModel["openrouter/some/unpriced-model"].priceKnown).toBe(false);
  });

  it("does not affect existing bySource breakdown", () => {
    const filePath = path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`);
    const logger = new TokenLogger(filePath);
    const summary = logger.summarize([
      entry({ sessionId: "s-alice", sessionTitle: "Alice", source: "user", provider: "claude", model: "sonnet" }),
      entry({ sessionId: "s-bob", sessionTitle: "Bob", source: "poll", provider: "openrouter", model: "openai/gpt-5.1" }),
    ]);

    expect(summary.bySource.user.messages).toBe(1);
    expect(summary.bySource.poll.messages).toBe(1);
    fs.rmSync(filePath, { force: true });
  });
});

describe("TokenLogger: bySession replaces byBot", () => {
  it("keys the breakdown by sessionId and carries the session title", () => {
    const logger = new TokenLogger(path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`));
    const summary = logger.summarize([
      entry({ sessionId: "sess-1", sessionTitle: "My Project", costUsd: 0.02 }),
      entry({ sessionId: "sess-1", sessionTitle: "My Project", costUsd: 0.03 }),
      entry({ sessionId: "sess-2", sessionTitle: "Other Project", costUsd: 0.01 }),
    ]);

    expect(summary.bySession["sess-1"]).toEqual({
      title: "My Project",
      costUsd: 0.05,
      messages: 2,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(summary.bySession["sess-2"].title).toBe("Other Project");
    expect((summary as unknown as { byBot?: unknown }).byBot).toBeUndefined();
  });

  it("loads a legacy entry with only botName as sessionId=<its own id>, title=botName", () => {
    const logger = new TokenLogger(path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`));
    // A pre-S10 JSONL line: no sessionTitle, only the legacy botName field.
    const legacy = entry({ sessionId: "legacy-sess", sessionTitle: undefined, botName: "Dev1" });
    const summary = logger.summarize([legacy]);

    expect(summary.bySession["legacy-sess"].title).toBe("Dev1");
  });

  it("falls back to 'unknown' when a legacy entry has neither sessionTitle nor botName nor sessionId", () => {
    const logger = new TokenLogger(path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`));
    const legacy = entry({ sessionId: "", sessionTitle: undefined, botName: undefined });
    const summary = logger.summarize([legacy]);

    expect(summary.bySession["unknown"]).toBeDefined();
    expect(summary.bySession["unknown"].title).toBe("unknown");
  });
});

describe("TokenLogger: bySubagent", () => {
  it("aggregates a subagent entry into both its parent session's total and bySubagent", () => {
    const logger = new TokenLogger(path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`));
    const summary = logger.summarize([
      // The parent session's own turn.
      entry({ sessionId: "parent-1", sessionTitle: "Parent Chat", costUsd: 0.10, inputTokens: 500, outputTokens: 200 }),
      // A subagent spawned from that session: sessionId is the PARENT session id.
      entry({
        sessionId: "parent-1",
        sessionTitle: "Parent Chat",
        source: "subagent",
        role: "subagent",
        agentId: "sa_abc123",
        provider: "claude",
        model: "haiku",
        subagentTask: "List the .ts files under server/src/engine and report the count.",
        costUsd: 0.02,
        inputTokens: 1000,
        outputTokens: 300,
      }),
    ]);

    // Parent session total includes both its own turn and the subagent's cost.
    expect(summary.bySession["parent-1"].costUsd).toBeCloseTo(0.12, 10);
    expect(summary.bySession["parent-1"].messages).toBe(2);

    // The subagent also gets its own row.
    const sub = summary.bySubagent["sa_abc123"];
    expect(sub).toBeDefined();
    expect(sub.parentSessionId).toBe("parent-1");
    expect(sub.engine).toBe("claude");
    expect(sub.model).toBe("haiku");
    expect(sub.costUsd).toBeCloseTo(0.02, 10);
    expect(sub.task).toContain("List the .ts files");
  });

  it("ignores a role:'subagent' entry with no agentId for bySubagent, but still rolls into bySession", () => {
    const logger = new TokenLogger(path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`));
    const summary = logger.summarize([
      entry({ sessionId: "parent-2", role: "subagent", agentId: undefined, costUsd: 0.01 }),
    ]);

    expect(Object.keys(summary.bySubagent)).toHaveLength(0);
    expect(summary.bySession["parent-2"].costUsd).toBeCloseTo(0.01, 10);
  });

  it("truncates a long task into a short summary", () => {
    const logger = new TokenLogger(path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`));
    const longTask = "x".repeat(500);
    const summary = logger.summarize([
      entry({ sessionId: "p", role: "subagent", agentId: "sa_long", subagentTask: longTask }),
    ]);

    expect(summary.bySubagent["sa_long"].task.length).toBeLessThanOrEqual(143);
  });
});
