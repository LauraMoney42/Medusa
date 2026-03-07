# Medusa Hub Bot Coordination System

**Purpose:** Reference document for porting the Medusa hub bot coordination system to a sister application.

**Date:** 2026-02-28

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [How Bots Are Addressed](#2-how-bots-are-addressed)
3. [How Bots Pick Up Tasks Autonomously](#3-how-bots-pick-up-tasks-autonomously)
4. [Bot System Prompts](#4-bot-system-prompts)
5. [Setting Up Bots in a New App](#5-setting-up-bots-in-a-new-app)
6. [Key Code Snippets](#6-key-code-snippets)
7. [Tuning and Configuration](#7-tuning-and-configuration)

---

## 1. System Overview

### What the Hub Is

The Hub is a **shared message board** visible to all bots and the human user. Every bot session and the user can post to it. It serves as the coordination layer for a multi-agent system where:

- The user assigns tasks by posting to the Hub (explicitly with `@BotName` or as a broadcast)
- Bots read the Hub context on every interaction and route their responses through it
- Bots post progress, completions, and escalations back to the Hub using the `[HUB-POST: ...]` marker
- The server detects special markers in bot output and routes them automatically

The Hub is not a chat UI — it is an **ambient coordination bus**. Bots are expected to read it passively and respond only when relevant.

### Architecture Diagram

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                          CLIENT (Browser)                        │
  │   User types message ──► Socket.IO emit("chat:message")         │
  │   Hub messages received ◄── Socket.IO on("hub:message")         │
  └─────────────────────────────────────────────────────────────────┘
                              │ Socket.IO
                              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                       SERVER (Node.js)                           │
  │                                                                  │
  │  ┌──────────────┐    ┌────────────────┐    ┌─────────────────┐  │
  │  │SocketHandler │    │  HubPollScheduler│   │  MentionRouter  │  │
  │  │  handler.ts  │    │poll-scheduler.ts│   │mention-router.ts│  │
  │  └──────┬───────┘    └───────┬─────────┘   └────────┬────────┘  │
  │         │                   │                        │           │
  │         └───────────────────┴───────────┬────────────┘           │
  │                                         │                        │
  │                              ┌──────────▼──────────┐             │
  │                              │  autonomousDeliver   │             │
  │                              │  autonomous-deliver.ts│            │
  │                              └──────────┬──────────┘             │
  │                                         │                        │
  │                    ┌────────────────────┼─────────────────────┐  │
  │                    │                    │                      │  │
  │             ┌──────▼──────┐   ┌────────▼───────┐  ┌──────────▼┐ │
  │             │  HubStore   │   │  ProcessManager │  │ ChatStore │ │
  │             │  (messages) │   │  (Claude CLI)   │  │(chat hist)│ │
  │             └──────┬──────┘   └────────┬───────┘  └───────────┘ │
  │                    │                   │                         │
  │                    │         ┌──────────▼──────────┐             │
  │                    │         │   Claude CLI (bot)   │             │
  │                    │         │  reads system prompt │             │
  │                    │         │  + Hub context block │             │
  │                    │         └──────────┬──────────┘             │
  │                    │                   │                         │
  │                    │    Bot outputs [HUB-POST: ...] in stream    │
  │                    │                   │                         │
  │                    │         ┌──────────▼──────────┐             │
  │                    │         │   HubPostDetector    │             │
  │                    │         │  (streaming parser)  │             │
  │                    └─────────┤  post-processor.ts   │             │
  │                              └─────────────────────┘             │
  └─────────────────────────────────────────────────────────────────┘
```

### Message Flow (Step by Step)

1. **User posts** a message to the Hub (or directly to a bot session).
2. **Server detects** the message via `MentionRouter` (for `@BotName` mentions) or the `HubPollScheduler` (periodic polling).
3. **Bot gets prompted** via `autonomousDeliver()` — the bot's system prompt is built with the Hub context block appended.
4. **Bot responds** — its response streams through `HubPostDetector`, which scans for `[HUB-POST: ...]` and `[BOT-TASK: ...]` markers in real time.
5. **Hub posts extracted** — any `[HUB-POST: ...]` content is stripped from the bot's chat response, added to `HubStore`, broadcast to all connected clients via `io.emit("hub:message")`, and routed through `MentionRouter` for further chaining.
6. **Completion events** — if the bot's hub post contains `[TASK-DONE: description]`, a `task:done` event is emitted and the bot's pending task tracking is cleared.

---

## 2. How Bots Are Addressed

### `@BotName` — Direct Mention (Always Wakes the Bot)

When any hub message contains `@BotName` (case-insensitive match against `session.name`), the `MentionRouter` immediately triggers that bot via `autonomousDeliver()`. The bot wakes regardless of whether it has pending tasks or is in hibernation.

```
User posts: "@Dev1 please add a login endpoint"
  → MentionRouter sees @dev1, matches session name "Dev1"
  → autonomousDeliver() called with source="mention"
  → Bot receives Hub context + the prompt
```

### `@all` — Broadcast to Every Bot

A message containing `@all` wakes every registered bot session. In the poll scheduler's relevance filter:

```typescript
// @all targets every bot — wake regardless of pending task status
if (lowerText.includes("@all")) return true;
```

Use `@all` sparingly — it triggers a full round of autonomous delivery for all bots simultaneously.

### `@You` — Escalation to the Human User

`@You` is the reserved address for the **human user**. Bots use it to escalate blockers, request approvals, or surface decisions that require human input. The standard escalation format (enforced via system prompt) is:

```
[HUB-POST: @You @Medusa 🚨🚨🚨 APPROVAL NEEDED: <description of what you need>]
```

The server does not auto-route `@You` to any bot. It appears on the Hub feed so the human user sees it. Hub messages containing `@you` are treated as relevant context for bots that have pending tasks (they need to know if their PM is waiting on human approval).

### Without `@` — Hibernation vs. Active Task Mode

The `HubPollScheduler` applies a **hibernation filter** when deciding which hub messages are relevant to each bot:

```typescript
const hasPendingTask = this.staleAssignments.has(session.id);

const relevantNew = newMessages.filter((m) => {
  if (m.sessionId === session.id) return false; // Exclude self-authored

  const lowerText = m.text.toLowerCase();

  // Direct @mention always wakes the bot
  if (lowerText.includes(`@${lowerName}`)) return true;

  // @all targets every bot
  if (lowerText.includes("@all")) return true;

  // HIBERNATING: only wake for direct @mentions / @all
  if (!hasPendingTask) return false;

  // ACTIVE TASK MODE: include broader context
  if (m.from === "System") return true;
  if (lowerText.includes("@you")) return true;
  if (!lowerText.includes("@")) return true; // Broadcasts
  return false;
});
```

**Hibernation mode** (no pending tasks): the bot only wakes for direct `@BotName` or `@all` messages. It ignores broadcasts, system messages, and `@You` escalations. This dramatically reduces unnecessary LLM calls.

**Active task mode** (pending task registered): the bot wakes for direct mentions, `@all`, System messages, `@You` escalations, and unaddressed broadcasts (messages with no `@` at all). This gives it full situational awareness while working.

### Why Bots Don't Respond to Everything

Without hibernation, every bot would respond to every hub message on every poll tick, causing:
- Massive token consumption
- Noisy Hub with bots acknowledging each other's messages endlessly
- Model rate limiting / API costs

Hibernation ensures bots are "off unless needed." Only when a bot has been explicitly given a task (tracked in `staleAssignments`) does it monitor the broader hub feed.

---

## 3. How Bots Pick Up Tasks Autonomously

### Poll Scheduler: How It Works

`HubPollScheduler` runs on a `setInterval` at `config.hubPollIntervalMs` (default: 60 seconds). Each **tick** does the following in order:

1. `checkStaleAssignments()` — nudge bots that were assigned a task but haven't reported progress
2. `checkBotHeartbeats()` — warn if a bot has been completely silent for 10+ minutes
3. `checkStatusUpdates()` — prompt idle bots for a status update if they haven't posted in 30 minutes
4. Read recent hub messages, filter per-bot relevance, and call `pollBot()` for eligible bots

**Constraints per tick:**
- Max 4 bots polled per tick (`MAX_BOTS_PER_TICK = 4`) to prevent stampedes
- 2-minute per-bot cooldown (`PER_BOT_COOLDOWN_MS = 2 * 60 * 1000`) — the same bot cannot be polled more than once every 2 minutes
- Bots are skipped if currently busy (`processManager.isSessionBusy()`)
- Delta tracking: bots are only polled if there are new hub messages since their last check (`lastSeenMessageId` map)

### `[Hub Check]` Prompt Format (Exact Text)

When a bot is polled and has new relevant messages, it receives this exact prompt:

```
[Hub Check] There are ${newMessageCount} new message(s) in the Hub since your last check.
Review them in the Hub context above. If any are relevant to your role or expertise,
respond via [HUB-POST: your response]. If you have assigned tasks you haven't started
or completed, start working on them now and post a status update. If you are blocked,
escalate with [HUB-POST: @You @Medusa 🚨🚨🚨 APPROVAL NEEDED: <what you need>].
If nothing needs your attention, respond with exactly: [NO-ACTION]
```

The Hub context (recent messages) is appended to the bot's system prompt — it is "above" the user-turn prompt from the bot's perspective.

### `[Status Check]` Prompt Format (Exact Text)

After `STATUS_UPDATE_INTERVAL_MS` (default: 30 minutes) of inactivity, idle bots receive:

```
[Status Check] It's been a while since your last update. Please post a brief project
status update to the Hub covering: what you completed, what's in progress, and any
blockers. Use [HUB-POST: your status]. If you have nothing to report, respond with
[NO-ACTION].
```

This is the `checkStatusUpdates()` method — it prevents bots from going silent after completing tasks.

### `[HUB-POST: ...]` — How Bots Post Back

Bots do not call an API to post to the Hub. Instead, they **embed the marker directly in their response text**. The server detects it during streaming via `HubPostDetector`:

- The detector scans each streaming delta for `[HUB-POST: ...]` (case-insensitive)
- When a complete token is detected, the content is extracted and stripped from the visible chat response
- The extracted text is passed to `processHubPosts()` which adds it to `HubStore`, emits `hub:message` to all clients, and routes any `@mentions`

A bot can include multiple `[HUB-POST: ...]` markers in a single response. Each is processed independently.

### `[TASK-DONE: description]` — Task Completion Tracking

When a bot includes `[TASK-DONE: description]` inside a hub post, the server:

1. Extracts the description using the `extractTaskDone()` regex
2. Adds a completion record to `HubStore.addCompletedTask()`
3. Emits `task:done` to all connected clients
4. Emits `session:pending-task` with `hasPendingTask: false` — this clears the bot from `staleAssignments`, returning it to hibernation mode

Example bot output:
```
[HUB-POST: Login endpoint complete. [TASK-DONE: Implemented POST /auth/login with JWT]]
```

### `[NO-ACTION]` — How Silence Is Handled

When a bot responds with `[NO-ACTION]` to a poll or status-check prompt, the server **suppresses the entire exchange from chat history**. Neither the poll prompt nor the `[NO-ACTION]` response is saved to `ChatStore`. This keeps the bot's conversation history clean and avoids polluting context with hundreds of empty check-ins.

Detection logic in `autonomous-deliver.ts`:

```typescript
if (checkNoAction) {
  const isNoAction =
    assistantText.trim() === "[NO-ACTION]" ||
    assistantText.includes("[NO-ACTION]");

  if (isNoAction) {
    // Skip persistence — discard the exchange entirely
  } else {
    // Persist both user prompt and assistant response normally
    chatStore.appendMessage(userMsg);
    chatStore.appendMessage({ ... assistantText ... });
  }
}
```

`checkNoAction` is only `true` for `source === "poll"` and `source === "status-check"`. Mention-triggered responses are always persisted.

### `[BOT-TASK: @BotName message]` — Bot-to-Bot Routing (Invisible to User)

Bots can delegate work to other bots without posting to the public Hub feed. The `[BOT-TASK: @BotName message]` marker routes a prompt directly to the target bot via `mentionRouter.processBotTaskContent()`. It is:

- **Not** written to `HubStore`
- **Not** broadcast to the client as a `hub:message`
- **Not** visible to the user in the Hub UI
- Subject to a chain depth limit (max 3) enforced server-side

Intended use: internal task handoffs, delegation, status queries between bots that the user doesn't need to see. Use `[HUB-POST: @BotName ...]` when the user does need visibility.

From the system prompt:
> Rule: if a human doesn't need to read it → `[BOT-TASK:]`. If they do → `[HUB-POST:]`.

### Stale Task Detection and Auto-Nudge

When a bot is assigned a task (tracked in `staleAssignments`), the scheduler monitors it. If the bot has not reported progress after `STALE_TASK_THRESHOLD_MS` (default: configurable, see env vars) and is not currently busy:

1. A warning is posted to the Hub: `"⚠️ Dev1 was assigned a task 15 minutes ago and hasn't reported progress. Nudging..."`
2. The bot receives a direct nudge prompt via `autonomousDeliver()`:
   ```
   You were assigned a task via the Hub ${minutesAgo} minutes ago but haven't started
   or reported progress. Please check your Hub assignments and either start working
   or report what's blocking you.
   ```
3. Each bot is nudged at most once per task assignment (`nudged: true` flag is set immediately).

### Heartbeat Tracking

Every time a bot completes an `autonomousDeliver()` call (poll, mention, nudge, or bot-to-bot), `recordHeartbeat(sessionId)` is called. If a bot hasn't had **any** activity in 10 minutes (`HEARTBEAT_STALE_MS`) and is not currently busy, the scheduler posts a system warning to the Hub:

```
⚠️ Dev1 has been silent for 12 min. May need attention. @You @Medusa
```

This warning is throttled to once per 15 minutes per bot (`STALE_WARN_COOLDOWN_MS`) to avoid Hub spam.

---

## 4. Bot System Prompts

### Compact Mode Prompt

For routine operations (polls, nudges, status checks, bot-to-bot tasks), bots use a **compact system prompt** instead of their full role description. This is approximately 50% shorter and saves significant tokens on high-frequency internal ops.

The compact Hub section (injected after the compact system prompt base):

```
--- HUB ---
You are in COMPACT MODE. Respond in under 100 tokens unless the task requires more.
Skip preamble, context-setting, and sign-offs. Do not restate the question or assignment.
If no action needed: [NO-ACTION]. If action needed: do it immediately.
Post via [HUB-POST: ...]. Task completions: [TASK-DONE: description].
Escalate: [HUB-POST: @You @Medusa 🚨🚨🚨 APPROVAL NEEDED: <what>]
For internal bot-to-bot coordination only, use [BOT-TASK: @BotName message] — NOT [HUB-POST: ...]. Routes directly, invisible to user.
Active bots: Dev1, Dev2, Dev3, Medusa, Security

[Context: 4 previous message(s) already reviewed. 2 new message(s) below.]

[Medusa @ 2026-02-28T14:05:00.000Z]: @Dev1 implement the user profile API endpoint
[User @ 2026-02-28T14:06:00.000Z]: @all please prioritize the auth flow

--- END HUB ---
```

### Full Hub Prompt Structure

For mention-triggered interactions (not polls), the full Hub section is injected:

```
--- HUB (shared awareness feed) ---
The Hub is a shared message board where all bots can see each other's posts.
To post a new message to the Hub, include [HUB-POST: your message here] anywhere in your response.
To tag another bot for help, include their name with @: [HUB-POST: @BotName your question].
Only use [HUB-POST: ...] when you genuinely need to communicate — examples: flagging uncertainty,
asking for help, reporting task completion, handing off work, or coordinating with teammates.
When you complete an assigned task, include [TASK-DONE: brief description] inside your hub post.
Always post to the Hub when you finish assigned work or need input from the team.
If you have assigned tasks, report your progress. If you're stuck or blocked, say so.

IMPORTANT — Auto-continuation:
- When you finish a task, check the Hub for your next assignment. If you have one, start it
  immediately. Do NOT wait for the user to tell you to begin.
- If you are idle and see assigned work for you in the Hub, pick it up and start working.
- Only stop and wait if you have NO assigned tasks remaining.

IMPORTANT — Escalation:
- If you need human approval, a decision, or are blocked on something only the user can resolve,
  post to the Hub with this exact format:
  [HUB-POST: @You @Medusa 🚨🚨🚨 APPROVAL NEEDED: <description of what you need>]
- @Medusa will triage first — if it truly needs the user, Medusa will re-escalate to @You.
- Do NOT silently wait. Always escalate visibly.

IMPORTANT — Token Efficiency:
- When posting to the Hub, keep it under 50 tokens. No pleasantries, no restating what was said.
- Status updates: state only what changed and what's next.
- Acknowledgments: "Acknowledged" or "Confirmed" is sufficient.
- [NO-ACTION] responses: respond with exactly "[NO-ACTION]" — no explanation needed.
- Never open with filler like "Great question!", "Absolutely!", "Thanks for the update!"
- Bot-to-bot communication is signal, not conversation. Be terse.

IMPORTANT — Bot-to-Bot Coordination:
- Use [BOT-TASK: @BotName message] for internal coordination. Routes directly. NOT visible in Hub.
- Use [HUB-POST: ...] ONLY when the user needs to see it.
- Chain depth limit enforced server-side (max 3).

Active bots: Dev1, Dev2, Dev3, Medusa, Security

[Dev1 @ 2026-02-28T14:00:00.000Z]: Starting the auth endpoint
[Medusa @ 2026-02-28T14:01:00.000Z]: @Dev2 review Dev1's PR when ready

--- END HUB ---
```

### How COMPACT MODE Reduces Tokens

Compact mode is activated for all autonomous (non-user-initiated) delivery sources:

```typescript
const compactMode =
  source === "poll" ||
  source === "nudge" ||
  source === "mention" ||
  source === "bot-to-bot" ||
  source === "status-check";
```

When `compactMode = true`:
- The **system prompt base** switches from the full role description to the compact role prompt (see role table below)
- The **Hub section** switches to the compact format (5 messages max instead of 20, terse instructions)
- The **compression level** used by the token compressor is set to `"aggressive"` instead of `"moderate"`

Combined, these reduce token usage by approximately 50% on routine ops.

### Role-Based Compact Prompts

Roles are auto-detected from the session name or full system prompt content. Custom `compactSystemPrompt` fields on a session override auto-detection.

| Role | Detection Pattern | Compact Prompt |
|------|------------------|----------------|
| **PM / Medusa** | `pm`, `product manager`, `medusa`, `orchestrat` | "You are a PM. Prioritize, assign, track. Be terse. Under 100 tokens for status updates. Post assignments via [HUB-POST:]. Track completions via [TASK-DONE:]. Escalate blockers to @You @Medusa immediately. Medusa triages first — only re-escalate to @You if it truly needs the user." |
| **Security** | `securit` | "You are a security reviewer. Audit code for vulnerabilities. Issue verdicts: PASS / FAIL / CAUTION. Be terse. Flag issues with exact file + line. Never skip security-relevant content." |
| **UI / Frontend** | `ui`, `frontend`, `ui dev` | "You are a UI dev. Build what's assigned. Report [TASK-DONE:] when finished. Be terse in Hub posts. Follow existing component patterns." |
| **Full Stack** | `full stack`, `fullstack` | "You are a full stack dev. Build what's assigned. Report [TASK-DONE:] when finished. Be terse in Hub posts. TypeScript strict, zero errors." |
| **Backend** | `backend`, `back end` | "You are a backend dev. Build what's assigned. Report [TASK-DONE:] when finished. Be terse in Hub posts. TypeScript strict, zero errors." |
| **Marketing** | `marketing` | "You are a marketing bot. Draft copy, review messaging. Be terse in Hub posts. Report [TASK-DONE:] when finished." |
| **Generic** | (fallback) | "You are a dev bot. Build what's assigned. Report [TASK-DONE:] when finished. Be terse in Hub posts." |

---

## 5. Setting Up Bots in a New App (Copy-Paste Instructions)

### Required Environment Variables

Add these to your `.env`:

```env
# Enable hub polling (set to "true" to activate the scheduler)
HUB_POLLING=true

# How often the poll scheduler ticks, in milliseconds (default: 60000 = 1 minute)
HUB_POLL_INTERVAL_MS=60000

# How often idle bots are prompted for a status update, in ms (default: 1800000 = 30 min)
STATUS_UPDATE_INTERVAL_MS=1800000

# How long a task assignment can go unreported before a nudge is sent, in ms
# Default: 900000 = 15 minutes
STALE_TASK_THRESHOLD_MS=900000
```

### How to Create a Bot Session

A bot session requires these fields in `SessionMeta`:

```typescript
interface SessionMeta {
  id: string;              // Unique session ID (uuid)
  name: string;            // Display name — used for @mentions, e.g. "Dev1"
  systemPrompt: string;    // Full role description (used for mention-triggered ops)
  compactSystemPrompt?: string; // Optional: override for compact mode. Auto-generated if omitted.
  workingDir: string;      // Working directory for Claude CLI process
  yoloMode?: boolean;      // If true, Claude CLI runs with --dangerously-skip-permissions
  model?: string;          // Optional model override
}
```

The `name` field is critical — it is used for `@BotName` matching (case-insensitive). Keep names short and unambiguous.

### Bot System Prompt Template

Copy and customize this template for each bot:

```
You are [BotName], a [role description] on the [ProjectName] team.

## Your Responsibilities
- [Primary responsibility 1]
- [Primary responsibility 2]
- [Primary responsibility 3]

## Working Style
- You work autonomously on assigned tasks without needing constant check-ins.
- When you complete a task, immediately check the Hub for your next assignment.
- You are terse and technical in Hub posts — no pleasantries, no restating context.
- You prefer code over explanation when demonstrating solutions.

## Tech Stack
- [Language/framework stack]
- [Conventions: e.g., TypeScript strict mode, zero `any`]
- [Test requirements]

## Escalation Rules
- If you need a decision only the human can make, post:
  [HUB-POST: @You @Medusa 🚨🚨🚨 APPROVAL NEEDED: <what you need>]
- Never silently block. Always escalate visibly and immediately.
- If you need another bot's help, use [BOT-TASK: @BotName your request] (invisible to user)
  or [HUB-POST: @BotName your question] (visible in Hub).

## Hub Posting Rules
- Only post to the Hub when there is something the team needs to know.
- Task complete: [HUB-POST: Done. [TASK-DONE: brief description]]
- Blocked: [HUB-POST: @You @Medusa 🚨🚨🚨 APPROVAL NEEDED: <reason>]
- Handoff: [HUB-POST: @Dev2 PR ready for review at <path>]
- No-op check: [NO-ACTION]
```

### How to Configure Bot Roles and Personalities

**Option A: Auto-detection (recommended for standard roles)**

Name your bot sessions with role keywords and compact mode prompts are generated automatically:
- `"Medusa"` or `"PM"` → PM role
- `"Dev1"`, `"Dev2"`, `"Dev3"` → generic dev role (full stack if name contains "fullstack")
- `"Security"` → security reviewer role
- `"Frontend"` or `"UI Dev"` → UI dev role

**Option B: Custom compact prompt**

Set `compactSystemPrompt` on the session to override auto-generation:

```typescript
session.compactSystemPrompt = "You are a data pipeline engineer. Build ETL jobs. " +
  "Report [TASK-DONE:] when finished. Be terse. Python 3.11, type-annotated.";
```

**Option C: Full system prompt only**

If `compactSystemPrompt` is not set and the name doesn't match any role pattern, the system falls back to the generic dev compact prompt. Set a descriptive full `systemPrompt` — the auto-detector also scans its content for role keywords as a secondary check.

### Wiring Up the Poll Scheduler

```typescript
// In your server startup:
const pollScheduler = new HubPollScheduler(
  processManager,
  sessionStore,
  hubStore,
  mentionRouter,
  io,
  chatStore,
  tokenLogger,    // optional
  quickTaskStore  // optional
);

if (process.env.HUB_POLLING === "true") {
  pollScheduler.start();
}

// When a bot is assigned a task (emit from session:pending-task event):
pollScheduler.trackPendingTask(sessionId);

// When a bot completes a task:
pollScheduler.clearPendingTask(sessionId);

// When a session is deleted:
pollScheduler.removeSession(sessionId);

// On bot activity (after autonomousDeliver resolves):
pollScheduler.recordHeartbeat(sessionId);
```

---

## 6. Key Code Snippets

### The `pollBot()` Prompt String

From `server/src/hub/poll-scheduler.ts`:

```typescript
private pollBot(sessionId: string, newMessageCount: number, sinceMessageId?: string): void {
  const meta = this.sessionStore.get(sessionId);
  if (!meta) return;

  this.lastPollTime.set(sessionId, Date.now());

  const prompt = `[Hub Check] There are ${newMessageCount} new message(s) in the Hub since your last check. Review them in the Hub context above. If any are relevant to your role or expertise, respond via [HUB-POST: your response]. If you have assigned tasks you haven't started or completed, start working on them now and post a status update. If you are blocked, escalate with [HUB-POST: @You @Medusa 🚨🚨🚨 APPROVAL NEEDED: <what you need>]. If nothing needs your attention, respond with exactly: [NO-ACTION]`;

  autonomousDeliver({
    sessionId,
    prompt,
    source: "poll",
    // ... other params
    sinceMessageId, // TC-5: delta context — only new messages since this ID
  });
}
```

### The `[TASK-DONE:]` Regex Extractor

From `server/src/socket/handler.ts`:

```typescript
/**
 * Extract [TASK-DONE: description] from hub message text.
 * Returns the description string or null if not found.
 */
export function extractTaskDone(text: string): string | null {
  const match = text.match(/\[TASK-DONE:\s*(.*?)\]/i);
  return match ? match[1].trim() : null;
}
```

Used in `post-processor.ts` after every hub post is added to the store:

```typescript
const taskDesc = extractTaskDone(postText);
if (taskDesc) {
  const task = hubStore.addCompletedTask({
    hubMessageId: hubMsg.id,
    from,
    description: taskDesc,
    sessionId,
  });
  io.emit("task:done", task);
  io.emit("session:pending-task", { sessionId, hasPendingTask: false });
}
```

### The `checkStatusUpdates()` Method

From `server/src/hub/poll-scheduler.ts`:

```typescript
private checkStatusUpdates(): void {
  const now = Date.now();
  const allSessions = this.sessionStore.loadAll();

  for (const session of allSessions) {
    if (session.name === "You" || session.name === "System") continue;
    if (this.processManager.isSessionBusy(session.id)) continue;

    const lastPrompt = this.lastStatusUpdatePrompt.get(session.id) ?? 0;
    if (now - lastPrompt < STATUS_UPDATE_INTERVAL_MS) continue;

    // Mark before sending to prevent re-trigger on next tick
    this.lastStatusUpdatePrompt.set(session.id, now);

    const prompt = `[Status Check] It's been a while since your last update. Please post a brief project status update to the Hub covering: what you completed, what's in progress, and any blockers. Use [HUB-POST: your status]. If you have nothing to report, respond with [NO-ACTION].`;

    autonomousDeliver({
      sessionId: session.id,
      prompt,
      source: "status-check",
      // ...
    }).then(() => {
      this.recordHeartbeat(session.id);
    });
  }
}
```

### The Compact Mode Hub Section Builder

From `server/src/socket/handler.ts` (`buildHubPromptSection()`):

```typescript
// Compact mode: minimal instructions for poll checks and routine ops
if (compactMode) {
  let section = `\n\n--- HUB ---
You are in COMPACT MODE. Respond in under 100 tokens unless the task requires more.
Skip preamble, context-setting, and sign-offs. Do not restate the question or assignment.
If no action needed: [NO-ACTION]. If action needed: do it immediately.
Post via [HUB-POST: ...]. Task completions: [TASK-DONE: description].
Escalate: [HUB-POST: @You @Medusa 🚨🚨🚨 APPROVAL NEEDED: <what>]
For internal bot-to-bot coordination only, use [BOT-TASK: @BotName message] — NOT [HUB-POST: ...]. Routes directly, invisible to user.
Active bots: ${botNames || "none"}`;

  if (deltaAnchor) section += deltaAnchor;

  if (recentMessages.length > 0) {
    section += "\n";
    for (const msg of recentMessages) {
      section += `\n[${msg.from} @ ${msg.timestamp}]: ${msg.text}`;
    }
  }
  section += "\n--- END HUB ---";
  return section;
}
```

The delta anchor is added when `sinceMessageId` is provided (TC-5 feature):

```typescript
if (delta.previousCount > 0) {
  deltaAnchor = `\n[Context: ${delta.previousCount} previous message(s) already reviewed. ${recentMessages.length} new message(s) below.]`;
}
```

### The `[NO-ACTION]` Suppression Logic

From `server/src/claude/autonomous-deliver.ts`:

```typescript
// Poll + status-check: defer persistence until NO-ACTION check
const persistUserMessage = source !== "poll" && source !== "nudge" && source !== "status-check";
const checkNoAction = source === "poll" || source === "status-check";

// ... after stream completes:

if (checkNoAction) {
  const isNoAction =
    assistantText.trim() === "[NO-ACTION]" ||
    assistantText.includes("[NO-ACTION]");

  if (isNoAction) {
    console.log(`[autonomous-deliver] ${meta.name} responded [NO-ACTION], skipping persistence`);
    // Neither the poll prompt nor the [NO-ACTION] response is saved to chat history
  } else {
    // Bot had something to say — persist the full exchange
    chatStore.appendMessage(userMsg);
    chatStore.appendMessage({
      id: assistantMsgId,
      sessionId,
      role: "assistant",
      text: assistantText,
      toolUses: assistantTools.length > 0 ? assistantTools : undefined,
      timestamp: now,
      cost: assistantCost,
      durationMs: assistantDurationMs,
    });
  }
}
```

---

## 7. Tuning and Configuration

### All Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HUB_POLLING` | `false` | Set to `"true"` to enable the poll scheduler. Without this, bots only respond to explicit `@mentions`. |
| `HUB_POLL_INTERVAL_MS` | `60000` | How often the scheduler ticks (milliseconds). Lower = more responsive bots, higher API costs. Minimum recommended: `30000`. |
| `STATUS_UPDATE_INTERVAL_MS` | `1800000` | How often idle bots are prompted for a project status update (milliseconds). Default: 30 minutes. Set to `0` to disable. |
| `STALE_TASK_THRESHOLD_MS` | (set in config) | How long a task assignment can sit unreported before a nudge is sent. Typically 15 minutes (`900000`). |
| `COMPRESSION_ENABLED` | `true` | Whether to run the token compressor on Hub context before injection. Set `false` to disable for debugging. |
| `COMPRESSION_LEVEL` | `moderate` | Default compression level for full mode. Compact mode always uses `aggressive`. Values: `light`, `moderate`, `aggressive`. |
| `COMPRESSION_AUDIT` | `false` | Set `true` to log what the compressor removed from each Hub context block. |

### Internal Constants (Hardcoded in `poll-scheduler.ts`)

These are not env vars — change them in source if needed:

| Constant | Value | Description |
|----------|-------|-------------|
| `PER_BOT_COOLDOWN_MS` | `2 * 60 * 1000` (2 min) | Minimum time between polls of the same bot. Prevents over-polling a single bot. |
| `MAX_BOTS_PER_TICK` | `4` | Max bots polled in a single tick. Prevents stampede when many bots have new messages. |
| `HEARTBEAT_STALE_MS` | `10 * 60 * 1000` (10 min) | How long a bot must be silent before a heartbeat warning is posted to Hub. |
| `STALE_WARN_COOLDOWN_MS` | `15 * 60 * 1000` (15 min) | Minimum time between heartbeat warnings for the same bot. Prevents Hub spam. |

### How to Adjust Poll Frequency

For more aggressive polling (faster bot response times):

```env
HUB_POLL_INTERVAL_MS=30000      # Tick every 30 seconds
STATUS_UPDATE_INTERVAL_MS=900000 # Status checks every 15 minutes
STALE_TASK_THRESHOLD_MS=600000  # Nudge after 10 minutes
```

For cost-conscious / slower environments:

```env
HUB_POLL_INTERVAL_MS=300000      # Tick every 5 minutes
STATUS_UPDATE_INTERVAL_MS=3600000 # Status checks every hour
STALE_TASK_THRESHOLD_MS=1800000  # Nudge after 30 minutes
```

Note: `PER_BOT_COOLDOWN_MS` (2 min) is a floor — lowering `HUB_POLL_INTERVAL_MS` below 2 minutes won't cause individual bots to be polled faster, only the tick to run more often (which just checks cooldowns and skips them anyway).

### How to Add a New Bot Type

**Step 1:** Add a role detection pattern and compact prompt to `compact-prompts.ts`:

```typescript
// In ROLE_PATTERNS array:
[/\bdata\s*engineer\b/i, "data"],

// In ROLE_COMPACT_PROMPTS object:
data: "You are a data engineer. Build ETL pipelines. Report [TASK-DONE:] when done. " +
      "Be terse. Python 3.11, type-annotated, tested.",
```

**Step 2:** Create a session with a name that matches your pattern:

```typescript
sessionStore.create({
  id: uuidv4(),
  name: "Data Engineer",
  systemPrompt: `You are a data pipeline specialist...`,
  workingDir: "/path/to/working/dir",
});
```

**Step 3:** The bot automatically participates in the Hub. No other wiring is needed — `HubPollScheduler` polls all registered sessions, and `MentionRouter` routes `@DataEngineer` mentions to the matching session.

**Step 4 (optional):** Set a custom compact prompt for fine-grained control:

```typescript
session.compactSystemPrompt = "You are a data engineer. " +
  "Build ETL pipelines with Python/Airflow. [TASK-DONE:] on completion. Terse.";
sessionStore.update(session);
```

### Delta Context (TC-5)

Each bot tracks the last Hub message ID it was polled about (`lastSeenMessageId`). On the next poll, only messages *after* that ID are included in the Hub context block, with an anchor line summarizing how many older messages were already reviewed. This prevents bots from re-reading the same history on every poll, keeping context windows lean as the Hub grows.

If `sinceMessageId` is not available (first poll, or ID not found), the full recent message window is used as a fallback.

---

*Generated from source files in `server/src/hub/` and `server/src/claude/` — 2026-02-28*
