# Medusa Architecture Review
**Date:** 2026-02-19
**Author:** Full Stack Dev
**Goal:** Evaluate current multi-bot architecture vs alternatives. Identify path to 1-2 entry points, parallel autonomous agents, lowest token cost.

---

## 1. Current Architecture: How It Works

### Entry Points (Today: 3)

| Entry Point | Trigger | Who handles it |
|---|---|---|
| **Socket.IO `message:send`** | User types in chat pane | `socket/handler.ts` → `ProcessManager.sendMessage()` |
| **Hub @mention** | Bot or user tags `@BotName` in Hub | `MentionRouter.deliverMention()` → `ProcessManager.sendMessage()` |
| **Poll scheduler** | Timer fires (default: 120s) | `HubPollScheduler.pollBot()` → `ProcessManager.sendMessage()` |

There are also two secondary entry points:
- **Stale nudge** (`HubPollScheduler.nudgeBot()`) — triggered within the poll scheduler when a bot is stale
- **Auto-resume** (`index.ts: resumeInterruptedSessions()`) — fires once on server startup

All paths converge on `ProcessManager.sendMessage()` → spawns `claude` CLI subprocess.

### Message Flow (User → Bot)

```
User types → socket "message:send"
  → socket/handler.ts buildHubPromptSection() [constructs system prompt]
  → ProcessManager.sendMessage() [acquires spawnLock]
    → spawn "claude -p <prompt> --resume <sessionId> --output-format stream-json"
    → StreamParser.feed() [parses SSE line by line]
    → onEvent callback:
        delta → HubPostDetector.feed() → strips [HUB-POST:] → emit message:stream:delta
        result → emit message:stream:end
        tool_use_start / tool_result → emit stream:tool events
  → HubPostDetector.flush() [captures trailing hub posts]
  → chatStore.appendMessage() [persists to chats/<sessionId>.json]
  → io.to(sessionId).emit("session:status", idle)
  → mentionRouter.onSessionIdle() [delivers any queued mention]
```

### Message Flow (Hub @mention → Bot)

```
User/Bot posts [HUB-POST: @TargetBot message]
  → post-processor.ts processHubPosts()
    → hubStore.add() [persists to hub.json]
    → io.emit("hub:message") [broadcasts to all clients]
    → mentionRouter.processMessage()
      → extractMentions() [scans for @names by session name]
      → if bot idle: deliverMention()
      → if bot busy: pendingMentions.set() [queued, max 1 pending per bot]
  → deliverMention():
    → buildHubPromptSection() [last 20 hub msgs filtered to this bot]
    → ProcessManager.sendMessage()
    → [same stream pipeline as above]
    → onSessionIdle() [delivers next pending mention]
```

### Hub Prompt Injection

Every call to `ProcessManager.sendMessage()` includes a `--system-prompt` built by `buildHubPromptSection()`:
- **Normal mode**: Last 20 hub messages filtered to those relevant to this bot (mentions of the bot, @you escalations, system messages, broadcasts). Includes full instructions (~400 tokens of boilerplate).
- **Compact mode** (poll/nudge): Last 5 messages, ~100-token instructions.

This is **the primary token cost driver** — every single message to every bot injects hub context into the system prompt, even if the hub is quiet.

---

## 2. Token Cost Analysis

### Per-Message Token Cost (estimated)

| Component | Tokens (approx) |
|---|---|
| Hub instructions boilerplate | ~400 |
| Hub messages (20 × ~50 tokens each) | ~1,000 |
| Session system prompt (custom) | varies (0–500) |
| Skills prompt | varies (0–2,000) |
| Conversation summary | varies (0–500) |
| Devlog (last N entries, read by Claude) | varies (~500–5,000) |
| User message | ~50–200 |
| **Total input per turn** | **~2,000–9,000 tokens** |

### Biggest Token Cost Drivers

1. **Hub prompt injected on every turn** — even for a 5-word user message, the bot receives ~1,400 tokens of hub context. This is by design but expensive.
2. **Poll scheduler** — wakes idle bots every 120s if new hub messages exist. Each poll = a full Claude invocation (haiku tier, but still ~2,000 input tokens). With 10 bots × 12 polls/hour = 120 haiku calls/hour at idle.
3. **Devlog** — bots read devlog.md on every task. At 500+ entries, this can be thousands of tokens. The paginator moves entries >48h old to `devlog_archive.md`, which helps but doesn't eliminate the problem.
4. **Conversation history in Claude Code** — `--resume` passes the full conversation history inside Claude Code's own context management. Medusa doesn't control this — it grows unbounded per session until `summarizeConversation()` triggers.
5. **Mention chain amplification** — one `@mention` spawns 1 Claude call; if the response has `[HUB-POST: @AnotherBot ...]`, that spawns another (up to `MAX_CHAIN_DEPTH=3`). 3-deep chains = 3× the tokens.

---

## 3. Architecture Alternatives Evaluated

### Option A: Current Architecture (N Entry Points)
**Current state.** Each message source (user socket, @mention, poll) has its own entry point with its own streaming pipeline boilerplate duplicated across `socket/handler.ts`, `mention-router.ts`, and `poll-scheduler.ts`.

**Problems:**
- The `spawnClaude` streaming pipeline is copy-pasted 4+ times (handler, mention-router, poll-scheduler, index.ts auto-resume). Any bug in streaming logic must be fixed in 4 places.
- Hub prompt injection hardcoded in each call site.
- Token cost uncontrolled — every entry point rebuilds the full system prompt independently.

**Pros:** Works today. Simple to reason about locally.

---

### Option B: Single Entry Point — Unified `sendToBot()` Gateway
**Proposed.** Extract all `ProcessManager.sendMessage()` call sites into one shared function:

```typescript
// server/src/claude/send-to-bot.ts
async function sendToBot(params: {
  sessionId: string;
  prompt: string;
  source: "user" | "mention" | "poll" | "nudge" | "resume";
  images?: string[];
  chainDepth?: number;
}): Promise<void>
```

All entry points (socket handler, mention router, poll scheduler, auto-resume) call `sendToBot()` instead of building their own pipelines. System prompt construction, streaming event handling, chat persistence, hub post detection, and session status management happen exactly once.

**Pros:**
- Token cost centralized — one place to optimize system prompt injection
- Streaming pipeline logic in one place — fix once, fixed everywhere
- Easier to add cross-cutting concerns (rate limiting, cost tracking, circuit breakers)
- Hub context can be shared/cached between calls in the same tick

**Cons:**
- Requires refactor across 4 files
- Must handle nuances per source (e.g., `NO-ACTION` skips persistence only for polls)

**Token savings:** Medium. Doesn't reduce tokens per call, but enables optimization.

---

### Option C: Event-Driven Internal Bus
**Proposed.** Replace the direct call chain with an internal event emitter:

```typescript
// All triggers emit an internal event
botBus.emit("send", { sessionId, prompt, source, ... });

// One subscriber handles all sends
botBus.on("send", async (params) => { /* single pipeline */ });
```

**Pros:** Maximum decoupling. Easy to add observability (log every send, track token costs).

**Cons:** More indirection, harder to debug. Overkill for current scale (5–15 bots).

---

### Option D: Reduce to 2 Entry Points (Recommended)
**Proposed.** Collapse the current 3+ entry points into 2:

1. **User entry point**: Socket `message:send` (direct user interaction)
2. **Autonomous entry point**: Everything else (mention, poll, nudge, resume) — all routed through a single `autonomousDeliver()` function

The key insight: poll, mention, nudge, and resume are all structurally identical — they all send a server-generated prompt to a bot and handle the response. They differ only in the prompt text and minor persistence rules. A single `autonomousDeliver()` function with a `source` parameter handles all of them.

```typescript
// Replaces 3 separate pipeline copies
async function autonomousDeliver(params: {
  sessionId: string;
  prompt: string;
  source: "mention" | "poll" | "nudge" | "resume";
  chainDepth?: number;
}): Promise<void>
```

**Token savings from this change:**
- Hub context can be built once per tick and cached for all bots polled in that tick
- `NO-ACTION` suppression applies uniformly (currently only implemented in poll-scheduler)
- Compact mode (lower token count) can be applied to all autonomous calls, not just polls
- Easier to add response caching: if 3 bots all see the same hub message and respond `[NO-ACTION]`, we could skip 2 of the 3 calls

**Estimated savings: 20–40% token reduction** from better compact mode coverage and shared prompt construction.

---

## 4. Parallel Autonomous Agent Execution

### Current State
Bots run **fully parallel** at the process level — each bot is an independent `claude` subprocess. Parallelism is not constrained by the architecture.

**Real constraints today:**
1. **`spawnLock`** — prevents concurrent sends to the same session (correct, necessary)
2. **`MAX_BOTS_PER_TICK=2`** — the poll scheduler only wakes 2 bots per tick. This is a deliberate throttle to prevent stampedes. With 10+ bots and 120s poll interval, this means some bots may wait multiple cycles.
3. **`MentionRouter.COOLDOWN_MS=60s`** — 60-second cooldown per bot for mentions. Prevents spam but also delays legitimate rapid task assignments.
4. **`MAX_CHAIN_DEPTH=3`** — limits bot-to-bot mention chains. Good safety guard.

### Recommendation: Increase MAX_BOTS_PER_TICK
Current limit of 2 bots/tick is conservative. At 120s interval and 10 bots, worst case is 5 minutes before all bots have been checked. For a responsive multi-agent system, this should be 4–5.

### Recommendation: Priority Queue for Mentions
Currently, `pendingMentions` holds at most 1 pending mention per bot (new mentions silently dropped if already queued). If a bot is busy and two different teammates mention it, only the first mention is delivered. This should be a small FIFO queue (max 3 items).

---

## 5. Recommendations (Priority Order)

### P0 (Immediate, high impact)
1. **Extract shared `autonomousDeliver()` function** — eliminate streaming pipeline duplication across mention-router, poll-scheduler, poll-scheduler nudge, and index.ts auto-resume. This is the highest-leverage change: reduces code, enables all subsequent optimizations.

### P1 (Next sprint)
2. **Apply compact mode to all autonomous calls** — currently only poll/nudge use compact mode (5 messages, ~100-token instructions). Mention delivery uses full mode (20 messages, ~400-token instructions). Since mention delivery is triggered by a specific message the bot already sees in its hub context, it doesn't need the full 20-message history. **Estimated saving: ~600 tokens per mention delivery.**

3. **Cache hub prompt per tick** — currently each bot in a poll tick independently calls `buildHubPromptSection()`. With shared `autonomousDeliver()`, build the hub section once and pass it to all bots in the same tick.

4. **Increase `MAX_BOTS_PER_TICK` to 4** — improves responsiveness with no token cost increase.

### P2 (Backlog)
5. **Pending mention queue (FIFO, max 3)** — prevents silent message drops when a busy bot gets multiple mentions.

6. **Token cost telemetry** — log `totalCostUsd` per session per day. Currently `cost` is stored per message in chat history but never aggregated. A simple daily rollup would make cost optimization measurable.

7. **Hub message deduplication** — if the same URL or code snippet appears in multiple hub messages, bots each receive it multiple times (once per message). Dedup identical content within the hub context window.

8. **Devlog pagination improvement** — current 48h threshold is generous. Reduce to 24h for active projects; bots rarely need yesterday's log entries for today's work.

---

## 6. Summary

| | Today | After P0+P1 |
|---|---|---|
| Entry points | 3 (+ 2 secondary) | 2 (user + autonomous) |
| Streaming pipeline copies | 4 | 1 |
| Hub tokens per mention | ~1,400 (full mode) | ~600 (compact mode) |
| Bots polled per tick | 2 | 4 |
| Token savings estimate | baseline | 20–40% |

The architecture is fundamentally sound for its scale (5–15 bots). The biggest wins come from **eliminating code duplication** (which enables optimization) and **applying compact mode more aggressively** (which directly cuts tokens). Neither change requires rethinking the overall design — they're focused refactors with measurable impact.
