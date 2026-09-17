# Medusa Multi-Bot AI System — Integration Guide

**Last updated:** 2026-02-28
**Intended audience:** Developers integrating the same multi-bot architecture into a sister application.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [How Medusa Knows You're Talking To Her (Without @)](#2-how-medusa-knows-youre-talking-to-her-without-)
3. [How Devs Pick Up Tasks Automatically (Not Stay Idle)](#3-how-devs-pick-up-tasks-automatically-not-stay-idle)
4. [Bot System Prompts](#4-bot-system-prompts)
5. [Adding This System to a New App (Copy-Paste Instructions)](#5-adding-this-system-to-a-new-app-copy-paste-instructions)
6. [Key Configuration (.env)](#6-key-configuration-env)

---

## 1. System Overview

Medusa is a **multi-bot AI coordination platform** built on three layers:

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser / Client (React + Socket.io)                           │
│  User types into Hub or individual bot chat sessions            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Socket.IO (ws)
┌──────────────────────────▼──────────────────────────────────────┐
│  Node.js / Express Server                                       │
│  ├── socket/handler.ts        — message routing + stream events  │
│  ├── hub/mention-router.ts    — @mention detection + delivery   │
│  ├── hub/poll-scheduler.ts    — background polling of idle bots  │
│  ├── hub/post-processor.ts    — [HUB-POST:] / [TASK-DONE:] logic│
│  ├── claude/autonomous-deliver.ts — sends prompts → Claude CLI  │
│  └── sessions/compact-prompts.ts  — per-role system prompts     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Child processes (one per bot)
┌──────────────────────────▼──────────────────────────────────────┐
│  Claude Code CLI processes                                       │
│  Each bot session = a persistent `claude` process               │
│  Bots: Medusa (PM), Dev1, Dev2, Dev3, Security, etc.            │
└─────────────────────────────────────────────────────────────────┘
```

### Core Concepts

| Concept | What it is |
|---|---|
| **Hub** | A shared message board. Every bot and the user can post to it. All bots see it injected into their system prompt on every request. |
| **Bot session** | A persistent Claude Code CLI process. Each bot has its own session ID, chat history, and system prompt. |
| **Server** | A Node.js/Express/Socket.IO backend that wires everything together — receives user messages, builds system prompts with Hub context, delivers them to the right Claude process, and streams responses back. |
| **Mention routing** | When a user or bot writes `@BotName` in the Hub, the server detects it and autonomously delivers the message to that bot's session. |
| **Poll scheduler** | A background timer that wakes idle bots every 60 seconds to check whether there is new Hub activity relevant to them. |

### Basic Request Flow

1. **User posts to Hub** via the frontend (`hub:post` socket event).
2. **Server receives the message**, saves it to the Hub store, and broadcasts it to all connected clients.
3. **`MentionRouter.processMessage()`** scans for `@mentions`. If none found and the message is from a human, it defaults to routing to Medusa.
4. **`autonomousDeliver()`** builds a system prompt (role prompt + Hub context + conversation summary), then sends the prompt to the target bot's Claude CLI process.
5. **The bot streams a response** back. The stream is parsed for `[HUB-POST: ...]` and `[BOT-TASK: ...]` markers.
6. **`processHubPosts()`** extracts Hub posts, saves them, broadcasts them, and re-runs mention routing — potentially triggering other bots.
7. **`[TASK-DONE: description]`** inside a Hub post fires a `task:done` socket event and runs `TaskSyncManager` to fuzzy-match and update project assignments.

---

## 2. How Medusa Knows You're Talking To Her (Without @)

### 2.1 The Hub Context — Injected Into Every Bot Request

Every time a message is delivered to a bot (whether from a user, a poll tick, or a mention), the server builds a **Hub prompt section** and appends it to that bot's system prompt. This means every bot, on every response, is aware of the current state of the shared Hub.

The builder lives in `server/src/socket/handler.ts`:

```typescript
// From server/src/socket/handler.ts — buildHubPromptSection()
export function buildHubPromptSection(
  hubStore: HubStore,
  sessionStore: SessionStore,
  forSessionId?: string,
  forSessionName?: string,
  compactMode = false,
  sinceMessageId?: string
): string {
  const messageLimit = compactMode ? 5 : 20;
  // ...fetches filtered messages relevant to this bot...

  let section = `\n\n--- HUB (shared awareness feed) ---
The Hub is a shared message board where all bots can see each other's posts.
To post a new message to the Hub, include [HUB-POST: your message here] anywhere in your response.
To tag another bot for help, include their name with @: [HUB-POST: @BotName your question].
Only use [HUB-POST: ...] when you genuinely need to communicate — examples: flagging uncertainty,
asking for help, reporting task completion, handing off work, or coordinating with teammates.
When you complete an assigned task, include [TASK-DONE: brief description] inside your hub post.
...
Active bots: ${botNames || "none"}`;

  // Appends filtered recent messages
  for (const msg of recentMessages) {
    section += `\n[${msg.from} @ ${msg.timestamp}]: ${msg.text}`;
  }

  section += "\n--- END HUB ---";
  return section;
}
```

This section is assembled fresh on every call to `autonomousDeliver()` or `setupSocketHandler()`, using messages filtered to what is relevant to **that specific bot** (messages mentioning them, system messages, `@all` posts, and — if they have pending tasks — broadcasts).

### 2.2 How Medusa Knows She IS Medusa

Each bot has a **system prompt** stored in `SessionMeta.systemPrompt`. For Medusa (the PM bot), this prompt defines her role, authority, and responsibilities. It is set when the session is created in the UI and is stored in `~/.claude-chat/sessions.json`.

When the server builds the final system prompt for a bot, it assembles:

```
[bot's stored systemPrompt]
+
[compact or full Hub section from buildHubPromptSection()]
+
[CONVERSATION SUMMARY (if conversation has been summarized)]
```

The system prompt tells Medusa she is the PM/orchestrator. The Hub section tells her what the current team context looks like. Together, she can respond to un-mentored Hub messages as the PM without any explicit `@Medusa` tag.

### 2.3 @Mention Routing — `mention-router.ts`

When any Hub message is saved, `MentionRouter.processMessage()` is called:

```typescript
// From server/src/hub/mention-router.ts
processMessage(hubMessage: HubMessage, chainDepth = 0): void {
  if (chainDepth >= MAX_CHAIN_DEPTH) return; // Max chain depth = 3

  const mentions = this.extractMentions(hubMessage.text, hubMessage.sessionId);
  const allSessions = this.sessionStore.loadAll();

  // If no @mentions in a user message, default to Medusa
  if (mentions.length === 0) {
    const isUserMessage = hubMessage.from === "User" || hubMessage.from === "You";
    if (!isUserMessage) return;
    const medusa = allSessions.find(
      (s) => s.name.toLowerCase() === "medusa"
    );
    if (medusa) {
      mentions.push(medusa.name);
    }
  }

  for (const mentionName of mentions) {
    const target = allSessions.find(
      (s) => s.name.toLowerCase() === mentionName.toLowerCase()
    );
    if (!target) continue;

    // Cooldown guard: 60 seconds between mentions to the same bot
    const lastTime = this.lastMentionTime.get(target.id) ?? 0;
    if (Date.now() - lastTime < MentionRouter.COOLDOWN_MS) continue;

    if (this.processManager.isSessionBusy(target.id)) {
      // Queue the mention (FIFO, max 3 pending per bot)
      const queue = this.pendingMentions.get(target.id) ?? [];
      if (queue.length < MentionRouter.MAX_PENDING) {
        queue.push({ hubMessage, chainDepth });
        this.pendingMentions.set(target.id, queue);
      }
    } else {
      this.deliverMention(target.id, hubMessage, chainDepth);
    }
  }
}
```

Mention extraction scans for `@BotName` patterns (case-insensitive, longest-name-first to prevent partial matches):

```typescript
// From server/src/hub/mention-router.ts — extractMentions()
private extractMentions(text: string, senderSessionId?: string): string[] {
  const allSessions = this.sessionStore.loadAll();
  const lowerText = text.toLowerCase();

  // @all pings every session except the sender
  if (lowerText.includes("@all")) {
    return allSessions
      .filter((s) => s.id !== senderSessionId)
      .map((s) => s.name);
  }

  const mentioned: string[] = [];
  // Sort longest names first to prevent partial matches
  // e.g. "@Full Stack Dev" must not match just "@Dev"
  const sorted = [...allSessions].sort(
    (a, b) => b.name.length - a.name.length
  );

  for (const session of sorted) {
    const pattern = `@${session.name.toLowerCase()}`;
    if (lowerText.includes(pattern)) {
      mentioned.push(session.name);
    }
  }

  return mentioned;
}
```

When a mention is delivered, the prompt sent to the target bot is:

```
[Hub Request] A teammate tagged you in the Hub: "<hub message text>" (from <sender name>).
Please review and respond. If you have something to share back, use [HUB-POST: your response].
```

### 2.4 Bot Hibernation vs Active State

Bots without pending tasks are in **hibernation** — they only wake up for direct `@mentions` or `@all` broadcasts. Bots **with** pending tasks receive a broader feed that also includes system messages, `@You` escalations, and general broadcasts.

This logic runs inside `HubPollScheduler.tick()`:

```typescript
// From server/src/hub/poll-scheduler.ts — tick()
const hasPendingTask = this.staleAssignments.has(session.id);
const lowerName = session.name.toLowerCase();

const relevantNew = newMessages.filter((m) => {
  // Exclude self-authored messages
  if (m.sessionId === session.id) return false;
  const lowerText = m.text.toLowerCase();

  // Direct @mention always wakes the bot
  if (lowerText.includes(`@${lowerName}`)) return true;

  // @all targets every bot regardless of pending task status
  if (lowerText.includes("@all")) return true;

  // Hibernating bots (no pending tasks) only wake for direct @mentions / @all
  if (!hasPendingTask) return false;

  // Bots with pending tasks: include broader context
  if (m.from === "System") return true;           // System messages
  if (lowerText.includes("@you")) return true;    // Escalations
  if (!lowerText.includes("@")) return true;      // Broadcasts with no @ at all
  return false; // Skip messages directed at other bots
});
```

**Summary of hibernation rules:**

| Bot state | Wakes for |
|---|---|
| Hibernating (no pending tasks) | `@BotName`, `@all` only |
| Active (has pending task) | `@BotName`, `@all`, System messages, `@You`, all broadcasts |

---

## 3. How Devs Pick Up Tasks Automatically (Not Stay Idle)

### 3.1 The Poll Scheduler — `poll-scheduler.ts`

`HubPollScheduler` runs a background `setInterval` (default: every 60 seconds). On each tick it:

1. Checks for **stale task assignments** and auto-nudges overdue bots.
2. Checks **heartbeat staleness** — flags bots that have been completely silent for more than 10 minutes.
3. Sends **proactive status update prompts** to bots that haven't reported in 30 minutes.
4. Delivers **Hub Check prompts** to bots that have new relevant Hub activity since their last check.

```typescript
// From server/src/hub/poll-scheduler.ts
start(): void {
  if (this.intervalHandle) return;
  this.intervalHandle = setInterval(() => this.tick(), config.hubPollIntervalMs);
  console.log("[poll-scheduler] Started");
}
```

**Key timing constants** (all configurable via env):

| Constant | Default | Purpose |
|---|---|---|
| `hubPollIntervalMs` | 60,000 ms (1 min) | How often `tick()` fires |
| `PER_BOT_COOLDOWN_MS` | 120,000 ms (2 min) | Min time between polls for a single bot |
| `MAX_BOTS_PER_TICK` | 4 | Max bots polled per tick (prevents stampede) |
| `HEARTBEAT_STALE_MS` | 600,000 ms (10 min) | When a bot is flagged as silent/stale |
| `STALE_WARN_COOLDOWN_MS` | 900,000 ms (15 min) | How often to re-warn about the same stale bot |
| `STATUS_UPDATE_INTERVAL_MS` | 1,800,000 ms (30 min) | How often to ask idle bots for a status update |

### 3.2 The Hub Check Prompt (Verbatim)

When a bot has new relevant Hub messages, `pollBot()` sends this prompt verbatim:

```
[Hub Check] There are ${newMessageCount} new message(s) in the Hub since your last check.
Review them in the Hub context above. If any are relevant to your role or expertise,
respond via [HUB-POST: your response]. If you have assigned tasks you haven't started
or completed, start working on them now and post a status update. If you are blocked,
escalate with [HUB-POST: @You 🚨🚨🚨 APPROVAL NEEDED: <what you need>]. If nothing
needs your attention, respond with exactly: [NO-ACTION]
```

The bot sees this as a user turn in its Claude session. The Hub context (injected into its system prompt) shows the actual messages. The bot decides what to do and responds accordingly.

**Delta context (TC-5):** Each bot tracks the last Hub message ID it saw (`lastSeenMessageId`). When polled again, only new messages since that ID are included in the Hub section — with an anchor line like `[Context: 5 previous message(s) already reviewed. 3 new message(s) below.]` — reducing token usage on repeated polls.

### 3.3 Stale Assignment Detection + Auto-Nudge

When Medusa (or a user) assigns a task to a bot, `trackPendingTask(sessionId)` is called. If the bot hasn't reported progress within `STALE_TASK_THRESHOLD_MS` (default: 10 minutes), the scheduler fires a nudge:

```typescript
// From server/src/hub/poll-scheduler.ts — nudgeBot()
private nudgeBot(sessionId: string, minutesAgo: number): void {
  const meta = this.sessionStore.get(sessionId);
  if (!meta) return;
  if (this.processManager.isSessionBusy(sessionId)) return;

  const prompt = `You were assigned a task via the Hub ${minutesAgo} minutes ago but haven't
started or reported progress. Please check your Hub assignments and either start working
or report what's blocking you.`;

  autonomousDeliver({
    sessionId,
    prompt,
    source: "nudge",
    // ...
  });
}
```

Each bot is only nudged **once per assignment** (`entry.nudged = true` prevents re-nudging). A `⚠️` warning is posted to the Hub so the human can see the bot was nudged.

### 3.4 The [TASK-DONE:] System

When a bot finishes a task, it includes `[TASK-DONE: description]` inside a `[HUB-POST: ...]`. The server detects this during streaming via `extractTaskDone()`:

```typescript
// From server/src/socket/handler.ts
export function extractTaskDone(text: string): string | null {
  const match = text.match(/\[TASK-DONE:\s*(.*?)\]/i);
  return match ? match[1].trim() : null;
}
```

`processHubPosts()` calls this on every extracted Hub post:

```typescript
// From server/src/hub/post-processor.ts — processHubPosts()
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

The `task:done` event is then picked up by `TaskSyncManager` which fuzzy-matches the description to open project assignments using Jaccard token similarity (threshold: 0.6 = 60% token overlap). If matched, the assignment is auto-marked `"done"` in `projects.json`:

```typescript
// From server/src/projects/task-sync.ts — scoreMatch()
private scoreMatch(
  botName: string,
  taskDesc: string,
  assignmentOwner: string,
  assignmentTask: string
): number {
  // Owner name must match exactly (case-insensitive)
  if (botName.toLowerCase() !== assignmentOwner.toLowerCase()) return 0;

  const taskTokens = this.tokenize(taskDesc);
  const assignmentTokens = this.tokenize(assignmentTask);

  const taskSet = new Set(taskTokens);
  const assignmentSet = new Set(assignmentTokens);
  const intersection = new Set([...taskSet].filter((t) => assignmentSet.has(t)));
  const union = new Set([...taskSet, ...assignmentSet]);

  // Jaccard similarity
  return intersection.size / union.size;
}
```

### 3.5 Status Check Interval (30 min)

Every 30 minutes, idle bots receive this prompt to prevent them from silently going dark after completing work:

```typescript
// From server/src/hub/poll-scheduler.ts — checkStatusUpdates()
const prompt = `[Status Check] It's been a while since your last update. Please post a brief
project status update to the Hub covering: what you completed, what's in progress, and any blockers.
Use [HUB-POST: your status]. If you have nothing to report, respond with [NO-ACTION].`;
```

This is delivered via `autonomousDeliver()` with `source: "status-check"`. If the bot responds `[NO-ACTION]`, the exchange is not persisted to chat history (keeping the session clean).

### 3.6 Heartbeat Tracking

Every call to `autonomousDeliver()` records a heartbeat via `recordHeartbeat(sessionId)`. If a bot has been silent (not busy, no polls, no activity) for more than `HEARTBEAT_STALE_MS` (10 min), a `⚠️` warning is posted to the Hub:

```typescript
// From server/src/hub/poll-scheduler.ts — checkBotHeartbeats()
const warningMsg = this.hubStore.add({
  from: "System",
  text: `⚠️ ${session.name} has been silent for ${minutesSilent} min. May need attention. @You`,
  sessionId: "",
});
io.emit("hub:message", warningMsg);
```

Warnings are throttled to once per `STALE_WARN_COOLDOWN_MS` (15 min) per bot.

---

## 4. Bot System Prompts

### 4.1 Two Prompt Modes Per Bot

Every bot has two modes (per the TO8 spec):

| Mode | When used | Token cost |
|---|---|---|
| **Full mode** | User-initiated messages, complex tasks | Full system prompt |
| **Compact mode** | Hub checks, polls, nudges, bot-to-bot coordination, status updates | ~50% shorter auto-generated prompt |

The mode is selected in `autonomous-deliver.ts`:

```typescript
// From server/src/claude/autonomous-deliver.ts
const compactMode = source === "poll" || source === "nudge" || source === "mention"
  || source === "bot-to-bot" || source === "status-check";

const basePrompt = compactMode
  ? getCompactPrompt(meta)        // compact-prompts.ts
  : (meta.systemPrompt || "");    // stored full prompt
```

### 4.2 Compact Prompts by Role — `compact-prompts.ts`

Role is detected from the session name (or system prompt content as fallback), then matched to a pre-defined compact prompt:

```typescript
// From server/src/sessions/compact-prompts.ts

// Role detection patterns — matched against session name (case-insensitive)
const ROLE_PATTERNS: [RegExp, BotRole][] = [
  [/\b(?:pm|product\s*manager|medusa|orchestrat)\b/i, "pm"],
  [/\bsecurit\b/i, "security"],
  [/\b(?:ui|frontend|ui\s*dev)\b/i, "ui"],
  [/\b(?:full\s*stack|fullstack)\b/i, "fullstack"],
  [/\b(?:backend|back\s*end)\b/i, "backend"],
  [/\bmarketing\b/i, "marketing"],
];

const ROLE_COMPACT_PROMPTS: Record<BotRole, string> = {
  pm:
    "You are a PM. Prioritize, assign, track. Be terse. Under 100 tokens for status updates. " +
    "Post assignments via [HUB-POST:]. Track completions via [TASK-DONE:]. " +
    "Escalate blockers to @You immediately.",

  security:
    "You are a security reviewer. Audit code for vulnerabilities. Issue verdicts: PASS / FAIL / CAUTION. " +
    "Be terse. Flag issues with exact file + line. Never skip security-relevant content.",

  ui:
    "You are a UI dev. Build what's assigned. Report [TASK-DONE:] when finished. " +
    "Be terse in Hub posts. Follow existing component patterns.",

  fullstack:
    "You are a full stack dev. Build what's assigned. Report [TASK-DONE:] when finished. " +
    "Be terse in Hub posts. TypeScript strict, zero errors.",

  backend:
    "You are a backend dev. Build what's assigned. Report [TASK-DONE:] when finished. " +
    "Be terse in Hub posts. TypeScript strict, zero errors.",

  marketing:
    "You are a marketing bot. Draft copy, review messaging. Be terse in Hub posts. " +
    "Report [TASK-DONE:] when finished.",

  generic:
    "You are a dev bot. Build what's assigned. Report [TASK-DONE:] when finished. " +
    "Be terse in Hub posts.",
};
```

**Priority:** If a session has a custom `compactSystemPrompt` field set (e.g. by the PM or user), that takes priority over the auto-generated role-based prompt.

### 4.3 Marker Reference

All bots are trained (via the Hub context section) to use these markers in their responses:

| Marker | What it does | Visible to user? |
|---|---|---|
| `[HUB-POST: message]` | Posts `message` to the Hub, broadcasts to all clients, triggers mention routing | Yes |
| `[TASK-DONE: description]` | Must be inside a `[HUB-POST:]`. Fires `task:done` event, triggers `TaskSyncManager` fuzzy-match, clears pending task state | Yes (via Hub post) |
| `[NO-ACTION]` | Tells the server the bot had nothing to do. Exchange is not persisted to chat history. | No |
| `[BOT-TASK: @BotName message]` | Routes a task directly to another bot's session. Not written to Hub, not visible to user. Chain depth capped at 3. | No |
| `[QUICK-TASK: title \| assignee]` | Auto-creates a quick task in the project task board. Optional `| assignee` field. | Reflected in task list |

### 4.4 The Full Hub Instruction Block (Injected Into Every System Prompt)

This is the full text injected into every bot's system prompt in non-compact mode (from `buildHubPromptSection()` in `handler.ts`):

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
  [HUB-POST: @You 🚨🚨🚨 APPROVAL NEEDED: <description of what you need>]
- Do NOT silently wait. Always escalate visibly.

IMPORTANT — Token Efficiency:
- When posting to the Hub, keep it under 50 tokens. No pleasantries, no restating what was already said.
- Status updates: state only what changed and what's next.
- [NO-ACTION] responses: respond with exactly "[NO-ACTION]" — no explanation needed.

IMPORTANT — Bot-to-Bot Coordination:
- Use [BOT-TASK: @BotName message] for internal coordination: task handoffs, delegation, status
  between bots. Routes directly. NOT visible in Hub.
- Use [HUB-POST: ...] ONLY when the user needs to see it (assignments, completions, escalations).
- Rule: if a human doesn't need to read it → [BOT-TASK:]. If they do → [HUB-POST:].
- Chain depth limit enforced server-side (max 3).

Active bots: Medusa, Dev1, Dev2, Security
[Medusa @ 2026-02-28T10:00:00Z]: @Dev1 please implement the login form
[Dev1 @ 2026-02-28T10:05:00Z]: On it. [TASK-DONE: login form implemented]
--- END HUB ---
```

---

## 5. Adding This System to a New App (Copy-Paste Instructions)

### Step 1: Copy the Core Files

Copy these files from `server/src/` into your new app's server:

```
server/src/
├── hub/
│   ├── store.ts              — Hub message persistence (JSON file)
│   ├── mention-router.ts     — @mention detection and routing
│   ├── post-processor.ts     — [HUB-POST:] / [TASK-DONE:] extraction
│   └── poll-scheduler.ts     — Background polling of idle bots
├── claude/
│   ├── autonomous-deliver.ts — Unified bot delivery pipeline
│   ├── process-manager.ts    — Claude CLI process management
│   └── model-router.ts       — Tiered model selection (haiku/sonnet/opus)
├── sessions/
│   ├── store.ts              — Session metadata persistence
│   └── compact-prompts.ts    — Role-based compact system prompts
├── socket/
│   └── handler.ts            — Socket.IO event handlers + buildHubPromptSection()
├── projects/
│   └── task-sync.ts          — TASK-DONE fuzzy matching to project assignments
└── config.ts                 — All env var parsing
```

Also copy the `compressor/` directory if you want token compression (recommended for production).

### Step 2: Set Up Environment Variables

Create a `.env` file in your project root (see [Section 6](#6-key-configuration-env) for full template). Minimum required:

```env
PORT=3456
AUTH_TOKEN=<generate with: openssl rand -hex 32>
HUB_POLLING=true
HUB_POLL_INTERVAL_MS=60000
```

### Step 3: Wire Up the Hub Store and Socket Handler

In your server's entry point (`index.ts` or `app.ts`):

```typescript
import { HubStore } from "./hub/store.js";
import { MentionRouter } from "./hub/mention-router.js";
import { HubPollScheduler } from "./hub/poll-scheduler.js";
import { SessionStore } from "./sessions/store.js";
import { setupSocketHandler } from "./socket/handler.js";
import config from "./config.js";

const hubStore = new HubStore(config.hubFile);
const sessionStore = new SessionStore(config.sessionsFile);
const chatStore = new ChatStore(config.chatDir);
const processManager = new ProcessManager();

const mentionRouter = new MentionRouter(
  processManager, sessionStore, hubStore, chatStore, io
);

const pollScheduler = new HubPollScheduler(
  processManager, sessionStore, hubStore, mentionRouter, io, chatStore
);

setupSocketHandler(io, processManager, sessionStore, skillCatalog, chatStore, hubStore, mentionRouter);

// Start polling if enabled
if (config.hubPolling) {
  pollScheduler.start();
}
```

### Step 4: Create Bot Sessions

Bot sessions are stored in `~/.claude-chat/sessions.json`. Each entry looks like:

```json
{
  "id": "uuid-here",
  "name": "Medusa",
  "systemPrompt": "You are Medusa, the project manager and orchestrator...",
  "workingDir": "/path/to/project",
  "yoloMode": false,
  "skills": []
}
```

You can create sessions via:
- The UI (if you have the Medusa frontend), or
- Directly via the REST API: `POST /api/sessions` with `{ name, systemPrompt, workingDir }`, or
- Manually editing the JSON file before startup.

**Minimum viable session for Medusa (PM):**

```json
{
  "name": "Medusa",
  "systemPrompt": "You are Medusa, the AI project manager. Your job is to understand the user's goals, break them into tasks, assign those tasks to the dev bots, track progress, and escalate blockers. When the user posts a message to the Hub without @mentioning anyone, you respond as the orchestrator. Use [HUB-POST: @BotName task description] to assign work."
}
```

**Minimum viable session for a dev bot:**

```json
{
  "name": "Dev1",
  "systemPrompt": "You are Dev1, a full-stack developer. Execute tasks assigned to you via the Hub. Always post [TASK-DONE: description] when you complete work. Escalate blockers with [HUB-POST: @You 🚨🚨🚨 APPROVAL NEEDED: reason]."
}
```

### Step 5: Integrate Task-Done Events

Wire up `TaskSyncManager` to listen for `task:done` events from Socket.IO:

```typescript
import { TaskSyncManager } from "./projects/task-sync.js";
import { ProjectStore } from "./projects/store.js";

const projectStore = new ProjectStore(config.projectsFile);
const taskSyncManager = new TaskSyncManager(projectStore);

// In your Socket.IO setup or event bus:
io.on("task:done", (task) => {
  taskSyncManager.handleTaskDone(task);
});
```

### Step 6: Configure Poll Scheduler Tracking

Call `trackPendingTask()` when a bot is assigned work, and `clearPendingTask()` when it completes:

```typescript
// When task is assigned
pollScheduler.trackPendingTask(sessionId);

// When task:done is received (this is done automatically via session:pending-task event)
// The socket event "session:pending-task" with hasPendingTask: false clears it
io.on("session:pending-task", ({ sessionId, hasPendingTask }) => {
  if (hasPendingTask) {
    pollScheduler.trackPendingTask(sessionId);
  } else {
    pollScheduler.clearPendingTask(sessionId);
  }
});
```

The server already emits `session:pending-task` automatically from `processHubPosts()` and `autonomousDeliver()`. You just need to hook into it on the server side.

### Integration Checklist

- [ ] `.env` file created with `AUTH_TOKEN`, `PORT`, `HUB_POLLING=true`
- [ ] `HubStore`, `SessionStore`, `ChatStore`, `ProcessManager` instantiated
- [ ] `MentionRouter` constructed and passed to `setupSocketHandler()`
- [ ] `HubPollScheduler` constructed and `.start()` called if `config.hubPolling` is true
- [ ] Bot sessions created in `sessions.json` with names and system prompts
- [ ] `TaskSyncManager` listening for `task:done` events (if using project assignments)
- [ ] `pollScheduler.trackPendingTask()` / `clearPendingTask()` called on `session:pending-task` events
- [ ] Claude Code CLI installed and accessible in PATH (the `claude` command must work)
- [ ] Working directories for bot sessions exist on disk

---

## 6. Key Configuration (.env)

### Copy-Paste .env Template

```env
# ── Server ────────────────────────────────────────────────────────
HOST=0.0.0.0
PORT=3456

# Authentication token — generate with: openssl rand -hex 32
AUTH_TOKEN=your_token_here

# Comma-separated allowed CORS origins
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173

# ── Hub Polling ───────────────────────────────────────────────────
# Enable background polling of idle bots (recommended: true)
HUB_POLLING=true

# How often the poll tick fires in ms (default: 60000 = 1 min)
HUB_POLL_INTERVAL_MS=60000

# Time before a pending task is considered stale and nudged (default: 600000 = 10 min)
STALE_TASK_THRESHOLD_MS=600000

# How often to prompt idle bots for status updates (default: 1800000 = 30 min)
STATUS_UPDATE_INTERVAL_MS=1800000

# ── Conversation Summarization ─────────────────────────────────────
# Compress old chat history into a rolling summary (default: true)
SUMMARIZATION_ENABLED=true

# Number of messages before summarization triggers (default: 30)
SUMMARIZATION_THRESHOLD=30

# ── Model Routing ─────────────────────────────────────────────────
# Enable tiered model selection: haiku (simple) → sonnet (coding) → opus (architecture)
MODEL_ROUTING_ENABLED=true

# ── Token Compression ─────────────────────────────────────────────
# Compress Hub context before injection to reduce input tokens (default: true)
COMPRESSION_ENABLED=true

# Level: conservative | moderate | aggressive (default: moderate)
COMPRESSION_LEVEL=moderate

# Emit compression audit log (default: false, set true for debugging)
COMPRESSION_AUDIT=false

# ── Shutdown ──────────────────────────────────────────────────────
# Max time in ms to wait for active sessions during shutdown (default: 30000)
GRACEFUL_TIMEOUT_MS=30000

# ── Multi-Account Claude ──────────────────────────────────────────
# Configure if you have two separate Claude accounts for different bots
ACCOUNT_1_NAME=Account 1
ACCOUNT_1_CONFIG_DIR=~/.claude
ACCOUNT_2_NAME=Account 2
ACCOUNT_2_CONFIG_DIR=~/.claude-account2

# ── Token Usage Logging ───────────────────────────────────────────
TOKEN_USAGE_LOG_FILE=~/.claude-chat/token-usage.jsonl
```

### Full Variable Reference

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `3456` | HTTP/WebSocket port |
| `AUTH_TOKEN` | _(auto-generated)_ | Bearer token for Socket.IO and REST API auth |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:5173` | CORS allowed origins |
| `HUB_POLLING` | `false` | Enable background bot polling. Must be `"true"` to activate. |
| `HUB_POLL_INTERVAL_MS` | `120000` | ms between poll ticks. Medusa defaults to 60000. |
| `STALE_TASK_THRESHOLD_MS` | `600000` | ms before an assigned-but-unstarted task triggers a nudge |
| `STATUS_UPDATE_INTERVAL_MS` | `1800000` | ms between proactive status check prompts to idle bots |
| `SUMMARIZATION_ENABLED` | `true` | Compress old chat into a rolling summary |
| `SUMMARIZATION_THRESHOLD` | `30` | Message count that triggers summarization |
| `MODEL_ROUTING_ENABLED` | `true` | Route simple prompts to haiku, code to sonnet, architecture to opus |
| `COMPRESSION_ENABLED` | `true` | Compress Hub context before injecting into system prompt |
| `COMPRESSION_LEVEL` | `moderate` | `conservative`, `moderate`, or `aggressive` |
| `COMPRESSION_AUDIT` | `false` | Log compression stats to console |
| `GRACEFUL_TIMEOUT_MS` | `30000` | How long shutdown waits for busy Claude sessions |
| `ACCOUNT_1_NAME` | `Account 1` | Display name for Claude account 1 |
| `ACCOUNT_1_CONFIG_DIR` | `~/.claude` | `CLAUDE_CONFIG_DIR` path for account 1 |
| `ACCOUNT_2_NAME` | `Account 2` | Display name for Claude account 2 |
| `ACCOUNT_2_CONFIG_DIR` | `~/.claude-account2` | `CLAUDE_CONFIG_DIR` path for account 2 |
| `TOKEN_USAGE_LOG_FILE` | `~/.claude-chat/token-usage.jsonl` | JSONL log of all token usage by bot/session |

### Storage File Locations (Non-Configurable Defaults)

All stored under `~/.claude-chat/`:

| File | What it stores |
|---|---|
| `sessions.json` | All bot session metadata (names, prompts, working dirs) |
| `hub.json` | Hub message history |
| `projects.json` | Project definitions and assignments |
| `quick-tasks.json` | Quick task board entries |
| `interrupted-sessions.json` | Sessions to auto-resume on next startup |
| `token-usage.jsonl` | Per-interaction token cost log |
| `compressor.json` | Optional: token compressor exclusion patterns |

---

## Appendix: Data Flow Diagram

```
User types in Hub
        │
        ▼
hub:post (socket event)
        │
        ▼
hubStore.add() → broadcast hub:message to all clients
        │
        ▼
mentionRouter.processMessage()
        │
        ├─ @BotName found? → deliverMention() → autonomousDeliver(source="mention")
        ├─ @all found?     → deliverMention() for all bots
        └─ No mentions + user message → deliverMention() to Medusa
                                │
                                ▼
                    autonomousDeliver()
                    ├── getCompactPrompt() or session.systemPrompt
                    ├── buildHubPromptSection() → Hub context
                    ├── compress() → reduce tokens
                    └── processManager.sendMessage() → Claude CLI subprocess
                                │
                        Claude streams response
                                │
                        HubPostDetector.feed(delta)
                        ├── cleanDelta → emit message:stream:delta
                        ├── [HUB-POST: ...] → processHubPosts()
                        │       ├── hubStore.add()
                        │       ├── io.emit("hub:message")
                        │       ├── mentionRouter.processMessage() ← chain routing
                        │       └── [TASK-DONE:]? → io.emit("task:done")
                        │                           → taskSyncManager.handleTaskDone()
                        └── [BOT-TASK: @Bot msg] → mentionRouter.processBotTaskContent()
                                                    → autonomousDeliver(source="bot-to-bot")


Background (every 60s):
HubPollScheduler.tick()
        ├── checkStaleAssignments() → nudgeBot() → autonomousDeliver(source="nudge")
        ├── checkBotHeartbeats()   → warn Hub if bot silent > 10 min
        ├── checkStatusUpdates()   → autonomousDeliver(source="status-check") every 30 min
        └── For each idle bot with new Hub messages:
            pollBot() → autonomousDeliver(source="poll")
                        Bot responds [NO-ACTION] or [HUB-POST: ...]
```
