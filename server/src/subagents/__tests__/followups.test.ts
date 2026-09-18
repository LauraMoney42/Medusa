import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  FollowupService,
  createFollowupTurnRunner,
  formatFollowupMessage,
  summarizeEnd,
  FOLLOWUP_SOURCE,
  SUMMARY_LIMIT,
  MAX_DELIVERY_ATTEMPTS,
  type FollowupTurn,
  type SubagentEndPayload,
} from "../followups.js";

interface Harness {
  service: FollowupService;
  turns: FollowupTurn[];
  emitted: { sessionId: string; event: string; payload: Record<string, unknown> }[];
  activity: { sessionId: string; kind: string; summary: string }[];
  setBusy: (busy: boolean) => void;
  /** Make the next `count` delivery attempts reject. */
  failNextTurn: (count?: number) => void;
}

function makeHarness(opts: { statePath?: string } = {}): Harness {
  let busy = false;
  let failures = 0;
  const turns: FollowupTurn[] = [];
  const emitted: Harness["emitted"] = [];
  const activity: Harness["activity"] = [];

  const service = new FollowupService({
    isBusy: () => busy,
    startTurn: (turn) => {
      if (failures > 0) {
        failures--;
        return Promise.reject(new Error("session is busy"));
      }
      turns.push(turn);
      return Promise.resolve();
    },
    emit: (sessionId, event, payload) => emitted.push({ sessionId, event, payload }),
    emitActivity: (line) =>
      activity.push({ sessionId: line.sessionId, kind: line.kind, summary: line.summary }),
    statePath: opts.statePath ?? "",
  });

  return {
    service,
    turns,
    emitted,
    activity,
    setBusy: (value) => {
      busy = value;
    },
    failNextTurn: (count = 1) => {
      failures += count;
    },
  };
}

function end(overrides: Partial<SubagentEndPayload> = {}): SubagentEndPayload {
  return {
    sessionId: "s1",
    agentId: "sa_aaa",
    name: "counter",
    status: "done",
    resultText: "42 files",
    ...overrides,
  };
}

describe("formatFollowupMessage", () => {
  it("uses the [Agent <name> <status>] shape and names agent_result", () => {
    const text = formatFollowupMessage([
      { agentId: "sa_1", name: "counter", status: "done", summary: "42 files" },
    ]);
    expect(text).toBe(
      "[Agent counter done] 42 files\nCall agent_result('sa_1') for the full output."
    );
  });

  it("separates merged agents with a blank line", () => {
    const text = formatFollowupMessage([
      { agentId: "sa_1", name: "a", status: "done", summary: "one" },
      { agentId: "sa_2", name: "b", status: "error", summary: "two" },
    ]);
    expect(text.split("\n\n")).toHaveLength(2);
    expect(text).toContain("[Agent b error] two");
  });
});

describe("summarizeEnd", () => {
  it("clips the result at 1500 chars", () => {
    const summary = summarizeEnd(end({ resultText: "x".repeat(4000) }));
    expect(summary).toHaveLength(SUMMARY_LIMIT);
  });

  it("uses the error text for a failed agent", () => {
    const summary = summarizeEnd(end({ status: "error", resultText: "", error: "boom" }));
    expect(summary).toBe("boom");
  });

  it("falls back to a placeholder when there is nothing to say", () => {
    expect(summarizeEnd(end({ resultText: "", error: undefined }))).toBe("no output");
  });
});

describe("FollowupService delivery", () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    h = makeHarness();
  });

  afterEach(() => {
    h.service.dispose();
    vi.useRealTimers();
  });

  it("emits followup:queued as soon as an agent ends", () => {
    h.service.handleSubagentEvent("subagent:end", end());
    const queued = h.emitted.find((e) => e.event === "followup:queued");
    expect(queued?.payload).toMatchObject({ sessionId: "s1", agentId: "sa_aaa" });
    expect(h.activity.some((a) => a.summary.includes("follow-up queued"))).toBe(true);
    expect(h.turns).toHaveLength(0);
  });

  it("delivers as a turn after the coalescing window when idle", async () => {
    h.service.handleSubagentEvent("subagent:end", end());
    await vi.advanceTimersByTimeAsync(2000);

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.sessionId).toBe("s1");
    expect(h.turns[0]!.agentIds).toEqual(["sa_aaa"]);
    expect(h.turns[0]!.text).toContain("[Agent counter done] 42 files");

    const delivered = h.emitted.find((e) => e.event === "followup:delivered");
    expect(delivered?.payload).toMatchObject({ sessionId: "s1", agentIds: ["sa_aaa"] });
  });

  it("holds while the session is busy and delivers once it goes idle", async () => {
    h.setBusy(true);
    h.service.handleSubagentEvent("subagent:end", end());

    await vi.advanceTimersByTimeAsync(5000);
    expect(h.turns).toHaveLength(0);
    expect(h.emitted.some((e) => e.event === "followup:delivered")).toBe(false);
    expect(h.service.pendingFor("s1")).toEqual(["sa_aaa"]);

    h.setBusy(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(h.turns).toHaveLength(1);
  });

  it("coalesces completions inside the 2 s window into one turn", async () => {
    h.service.handleSubagentEvent("subagent:end", end({ agentId: "sa_1", name: "a" }));
    await vi.advanceTimersByTimeAsync(1000);
    h.service.handleSubagentEvent("subagent:end", end({ agentId: "sa_2", name: "b" }));
    await vi.advanceTimersByTimeAsync(1500);

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.agentIds).toEqual(["sa_1", "sa_2"]);
    expect(h.turns[0]!.text).toContain("[Agent a done]");
    expect(h.turns[0]!.text).toContain("[Agent b done]");
  });

  it("never starts more than one follow-up turn per 10 s, merging the rest", async () => {
    h.service.handleSubagentEvent("subagent:end", end({ agentId: "sa_1", name: "a" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.turns).toHaveLength(1);

    h.service.handleSubagentEvent("subagent:end", end({ agentId: "sa_2", name: "b" }));
    await vi.advanceTimersByTimeAsync(3000);
    h.service.handleSubagentEvent("subagent:end", end({ agentId: "sa_3", name: "c" }));
    await vi.advanceTimersByTimeAsync(3000);
    // Still inside the 10 s window since the first delivery.
    expect(h.turns).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(h.turns).toHaveLength(2);
    expect(h.turns[1]!.agentIds).toEqual(["sa_2", "sa_3"]);
  });

  it.each(["error", "cancelled"] as const)("reports a %s agent", async (status) => {
    h.service.handleSubagentEvent(
      "subagent:end",
      end({ status, resultText: "", error: "killed" })
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.turns[0]!.text).toContain(`[Agent counter ${status}]`);
  });

  it("ignores non-terminal statuses and other subagent events", async () => {
    h.service.handleSubagentEvent("subagent:end", end({ status: "running" }));
    h.service.handleSubagentEvent("subagent:start", end());
    h.service.handleSubagentEvent("subagent:delta", end());
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.turns).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
  });

  it("never reports the same agent twice in one process", async () => {
    h.service.handleSubagentEvent("subagent:end", end());
    h.service.handleSubagentEvent("subagent:end", end());
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.agentIds).toEqual(["sa_aaa"]);
  });

  it("requeues the follow-up when the turn could not be started", async () => {
    h.failNextTurn();
    h.service.handleSubagentEvent("subagent:end", end());
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.turns).toHaveLength(0);
    expect(h.service.pendingFor("s1")).toEqual(["sa_aaa"]);

    // First retry is one backoff step (2x the idle poll) after the failure.
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.turns).toHaveLength(1);
  });

  it("gives up, and says so, when delivery keeps failing", async () => {
    const stubborn = makeHarness();
    stubborn.failNextTurn(MAX_DELIVERY_ATTEMPTS + 2);
    stubborn.service.handleSubagentEvent("subagent:end", end());

    await vi.advanceTimersByTimeAsync(120_000);
    expect(stubborn.turns).toHaveLength(0);
    expect(stubborn.service.pendingFor("s1")).toEqual([]);
    expect(
      stubborn.activity.some((a) => a.kind === "warning" && a.summary.includes("dropped"))
    ).toBe(true);
    stubborn.service.dispose();
  });

  it("keeps one session's follow-ups out of another's turn", async () => {
    h.service.handleSubagentEvent("subagent:end", end({ agentId: "sa_1" }));
    h.service.handleSubagentEvent(
      "subagent:end",
      end({ sessionId: "s2", agentId: "sa_2" })
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.turns).toHaveLength(2);
    expect(h.turns.map((t) => t.sessionId).sort()).toEqual(["s1", "s2"]);
  });
});

describe("FollowupService restart safety", () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-followups-"));
    statePath = path.join(dir, "followups.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not re-report an agent a previous run already delivered", async () => {
    const first = makeHarness({ statePath });
    first.service.handleSubagentEvent("subagent:end", end());
    await vi.advanceTimersByTimeAsync(2000);
    expect(first.turns).toHaveLength(1);
    expect(fs.existsSync(statePath)).toBe(true);
    first.service.dispose();

    // "Restart": a fresh service reading the same state file.
    const second = makeHarness({ statePath });
    second.service.handleSubagentEvent("subagent:end", end());
    await vi.advanceTimersByTimeAsync(5000);
    expect(second.turns).toHaveLength(0);
    expect(second.emitted).toHaveLength(0);
    second.service.dispose();
  });

  it("survives a corrupt state file", async () => {
    fs.writeFileSync(statePath, "{not json");
    const h = makeHarness({ statePath });
    h.service.handleSubagentEvent("subagent:end", end());
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.turns).toHaveLength(1);
    h.service.dispose();
  });
});

describe("createFollowupTurnRunner", () => {
  const session = {
    workingDir: "/tmp/project",
    engineId: "claude",
    model: "sonnet",
    systemPrompt: "notes",
    yoloMode: false,
  };

  function makeRunner(sendMessage: (...args: any[]) => Promise<number | null>) {
    const emitted: { event: string; payload: any }[] = [];
    const persisted: any[] = [];
    const runner = createFollowupTurnRunner({
      getSession: () => session,
      emit: (_sessionId, event, payload) => emitted.push({ event, payload }),
      persist: (msg) => persisted.push(msg),
      buildPrompt: () => "PROMPT",
      sendMessage: (sessionId, text, onEvent, opts) =>
        sendMessage(sessionId, text, onEvent, opts),
    });
    return { runner, emitted, persisted };
  }

  it("emits the follow-up as a system chip and starts the assistant stream", async () => {
    let captured: ((event: any) => void) | null = null;
    const { runner, emitted, persisted } = makeRunner(async (_id, _text, onEvent) => {
      captured = onEvent;
      return 0;
    });

    await runner({ sessionId: "s1", text: "[Agent a done] hi", agentIds: ["sa_1"] });

    const userMsg = emitted.find((e) => e.event === "message:user");
    expect(userMsg?.payload).toMatchObject({
      sessionId: "s1",
      role: "system",
      kind: "followup",
      source: FOLLOWUP_SOURCE,
      text: "[Agent a done] hi",
      agentIds: ["sa_1"],
    });
    expect(emitted.some((e) => e.event === "message:stream:start")).toBe(true);
    expect(persisted[0]).toMatchObject({
      role: "user",
      kind: "followup",
      source: FOLLOWUP_SOURCE,
    });
    expect(captured).toBeTypeOf("function");
  });

  it("rejects without emitting anything when the session turned busy", async () => {
    const { runner, emitted, persisted } = makeRunner(() =>
      Promise.reject(new Error("Session s1 is busy -- abort first"))
    );

    await expect(
      runner({ sessionId: "s1", text: "t", agentIds: ["sa_1"] })
    ).rejects.toThrow(/busy/);
    expect(emitted).toHaveLength(0);
    expect(persisted).toHaveLength(0);
  });

  it("streams deltas into the assistant message and persists the reply", async () => {
    let resolveSend: ((code: number) => void) | null = null;
    let onEvent: ((event: any) => void) | null = null;
    const { runner, emitted, persisted } = makeRunner(
      (_id, _text, cb) =>
        new Promise<number>((resolve) => {
          onEvent = cb;
          resolveSend = resolve;
        })
    );

    await runner({ sessionId: "s1", text: "t", agentIds: ["sa_1"] });
    onEvent!({ kind: "delta", text: "Done: " });
    onEvent!({ kind: "delta", text: "42 files." });
    onEvent!({ kind: "result", totalCostUsd: 0.01, durationMs: 10 });
    resolveSend!(0);
    await Promise.resolve();
    await Promise.resolve();

    const deltas = emitted.filter((e) => e.event === "message:stream:delta");
    expect(deltas.map((d) => d.payload.delta)).toEqual(["Done: ", "42 files."]);
    expect(emitted.filter((e) => e.event === "message:stream:end")).toHaveLength(1);
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toMatchObject({ text: "Done: 42 files.", source: FOLLOWUP_SOURCE });
  });
});
