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
    botName: "TestBot",
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

    expect(summary.byModel["openrouter/openai/gpt-5.1"]).toEqual({ costUsd: 0.08, messages: 2 });
    expect(summary.byModel["claude/sonnet"]).toEqual({ costUsd: 0.02, messages: 1 });
  });

  it("falls back to model-only or provider-only keys, and 'unknown' when neither is set", () => {
    const logger = new TokenLogger(path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`));
    const summary = logger.summarize([
      entry({ model: "sonnet" }),
      entry({ provider: "kimi" }),
      entry({}),
    ]);

    expect(summary.byModel["sonnet"]).toEqual({ costUsd: 0.01, messages: 1 });
    expect(summary.byModel["kimi"]).toEqual({ costUsd: 0.01, messages: 1 });
    expect(summary.byModel["unknown"]).toEqual({ costUsd: 0.01, messages: 1 });
  });

  it("does not affect existing byBot/bySource breakdowns", () => {
    const filePath = path.join(os.tmpdir(), `token-usage-test-${Date.now()}.jsonl`);
    const logger = new TokenLogger(filePath);
    const summary = logger.summarize([
      entry({ botName: "Alice", source: "user", provider: "claude", model: "sonnet" }),
      entry({ botName: "Bob", source: "poll", provider: "openrouter", model: "openai/gpt-5.1" }),
    ]);

    expect(summary.byBot.Alice.messages).toBe(1);
    expect(summary.byBot.Bob.messages).toBe(1);
    expect(summary.bySource.user.messages).toBe(1);
    expect(summary.bySource.poll.messages).toBe(1);
    fs.rmSync(filePath, { force: true });
  });
});
