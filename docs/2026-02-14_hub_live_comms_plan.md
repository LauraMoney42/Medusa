# Hub Live Communications — Implementation Plan
**Project: Medusa** (`~/Medusa`)
**Date:** 2026-02-14
**Author:** PM Bot
**Status:** Approved — ready for implementation

---

## Problem

Bots can't actually talk to each other through the Hub right now. Three issues:

1. **@mention responses are invisible.** `MentionRouter.deliverMention()` passes an empty `onEvent` callback to `processManager.sendMessage()`. The bot's response never goes through `HubPostDetector`, so any `[HUB-POST: ...]` in the reply is silently lost. The user never sees the back-and-forth.

2. **No background polling.** Bots only see Hub context when the user manually sends them a message. If nobody talks to a bot, it never checks the Hub. There's no way for a bot to proactively pick up tasks.

3. **External bots (like PM in Claude Code) can't post.** The Hub only has a GET endpoint. No REST POST exists for external tools to post messages.

---

## Solution: Three Changes

### Change 1: Fix @mention response streaming (CRITICAL)

**File:** `server/src/hub/mention-router.ts`

The `deliverMention()` method currently passes a no-op `onEvent`. Instead, it needs to:
- Pass a real `onEvent` callback that runs deltas through `HubPostDetector`
- Extract any `[HUB-POST: ...]` from the bot's response
- Store extracted posts in `hubStore` and broadcast via `io.emit("hub:message")`
- Stream the full response to the session room so users watching that session see it

This means `MentionRouter` needs access to `hubStore` and `io` (the Socket.IO server instance).

**Updated constructor:**
```typescript
constructor(
  processManager: ProcessManager,
  sessionStore: SessionStore,
  hubStore: HubStore,
  io: IOServer
)
```

**Updated `deliverMention()`:**
- Create a `HubPostDetector` instance
- Build system prompt with hub context (reuse `buildHubPromptSection`)
- Use a real `onEvent` callback that:
  - On `delta`: feed through `HubPostDetector`, emit `cleanDelta` to session room, handle extracted hub posts
  - On `result`: flush detector, emit `stream:end` to session room
  - On `error`: emit error to session room
- Emit `message:user` (the Hub Request prompt), `message:stream:start`, deltas, and `message:stream:end` so users watching the session see the full exchange
- Persist both the user message and assistant response to `chatStore`

**Updated `processMessage()`:**
- After a bot responds via @mention and posts back to Hub, check if THAT response also has @mentions (chain routing)
- Add a max chain depth of 3 to prevent infinite loops

**Files affected:**
- `server/src/hub/mention-router.ts` — major rewrite
- `server/src/socket/handler.ts` — export `buildHubPromptSection` and `HubPostDetector` so mention-router can use them
- `server/src/index.ts` — pass `hubStore`, `io`, and `chatStore` to `MentionRouter` constructor

### Change 2: Add REST POST /api/hub endpoint

**File:** `server/src/routes/hub.ts`

Add a POST endpoint so external tools (PM bot in Claude Code, CLI scripts, future integrations) can post to the Hub.

```
POST /api/hub
Body: { from: string, text: string, sessionId?: string }
```

- `from` is required (the name to display, e.g. "Product Manager")
- `sessionId` is optional (if posting on behalf of a session)
- If `sessionId` is provided, look up session name and use that as `from` instead
- Auth: same Bearer token as all other endpoints
- After storing, broadcast `hub:message` via `io.emit()` and run through `mentionRouter.processMessage()`

This requires `io` to be accessible in the route. Pass it as a parameter to `createHubRouter()`.

**Updated signature:**
```typescript
createHubRouter(hubStore: HubStore, io: IOServer, mentionRouter: MentionRouter, sessionStore: SessionStore)
```

### Change 3: Background Hub polling for idle bots

**New file:** `server/src/hub/poll-scheduler.ts`

A lightweight scheduler that periodically checks the Hub for unaddressed messages and nudges idle bots to review them.

**How it works:**
- Runs on a configurable interval (default: 5 minutes)
- On each tick:
  1. Get recent hub messages (last 20)
  2. Find messages that are "unaddressed" — no @mention, or @mentioned a bot that hasn't responded yet
  3. For each idle bot that hasn't been polled recently (10-minute per-bot cooldown):
     - Send a lightweight prompt: `"[Hub Check] Review the Hub for any items that need your attention. If nothing is relevant to you, do nothing. If you can help, respond via [HUB-POST: your response]."`
     - The bot's system prompt already includes hub context, so it has full visibility
  4. Track which messages each bot has "seen" to avoid re-prompting about the same items

**Guard rails:**
- Per-bot cooldown: 10 minutes minimum between polls
- Only poll idle bots (never interrupt busy ones)
- Max 2 bots polled per tick (prevent stampede)
- Polling is disabled by default — enabled via config or ENV var `HUB_POLLING=true`
- Poll interval configurable via `HUB_POLL_INTERVAL_MS` (default 300000 = 5 min)

**Class:**
```typescript
class HubPollScheduler {
  constructor(
    processManager: ProcessManager,
    sessionStore: SessionStore,
    hubStore: HubStore,
    mentionRouter: MentionRouter,
    io: IOServer,
    chatStore: ChatStore
  )

  start(): void      // Begin interval
  stop(): void       // Clear interval
}
```

**Files affected:**
- `server/src/hub/poll-scheduler.ts` — NEW
- `server/src/config.ts` — add `hubPolling: boolean` and `hubPollIntervalMs: number`
- `server/src/index.ts` — instantiate and start `HubPollScheduler` if enabled

---

## Updated File List

| # | File | Type | Change |
|---|------|------|--------|
| 1 | `server/src/hub/mention-router.ts` | MODIFIED | Major rewrite — real streaming, hub detection, chain routing |
| 2 | `server/src/socket/handler.ts` | MODIFIED | Export `HubPostDetector` and `buildHubPromptSection` |
| 3 | `server/src/routes/hub.ts` | MODIFIED | Add POST endpoint, accept `io` + `mentionRouter` params |
| 4 | `server/src/hub/poll-scheduler.ts` | NEW | Background polling for idle bots |
| 5 | `server/src/config.ts` | MODIFIED | Add polling config vars |
| 6 | `server/src/index.ts` | MODIFIED | Updated wiring for all new dependencies |

---

## Implementation Order

1. Export `HubPostDetector` and `buildHubPromptSection` from `handler.ts`
2. Rewrite `mention-router.ts` with real streaming + hub detection
3. Update `index.ts` to pass new dependencies to `MentionRouter`
4. Add POST endpoint to `routes/hub.ts`
5. Update `index.ts` to pass `io` + `mentionRouter` to hub router
6. Create `poll-scheduler.ts`
7. Add polling config to `config.ts`
8. Wire up scheduler in `index.ts`
9. Test the full loop

---

## Acceptance Criteria

### @mention streaming (Change 1)
- [ ] Bot A posts `[HUB-POST: @BotB check login.ts]` → BotB receives Hub Request in its chat
- [ ] BotB's response streams to its session room (visible if user is watching)
- [ ] If BotB responds with `[HUB-POST: ...]`, it appears in the Hub feed
- [ ] User sees the full back-and-forth in the Hub
- [ ] Chain mentions work up to depth 3 then stop
- [ ] Both the Hub Request prompt and bot response are persisted to chat history

### REST POST (Change 2)
- [ ] `POST /api/hub` with `{ from: "PM", text: "..." }` creates a hub message
- [ ] Message broadcasts to all clients and appears in Hub feed
- [ ] @mentions in the POST body trigger mention routing
- [ ] Auth required (Bearer token)
- [ ] Returns 201 with the created HubMessage

### Background polling (Change 3)
- [ ] When `HUB_POLLING=true`, scheduler starts on server boot
- [ ] Idle bots get polled at the configured interval
- [ ] Polled bot sees Hub context and can respond via `[HUB-POST: ...]`
- [ ] Per-bot 10-minute cooldown prevents spam
- [ ] Max 2 bots per tick
- [ ] Polling disabled by default

### General
- [ ] `npx tsc --noEmit` passes on server
- [ ] `npm run build` succeeds
- [ ] No infinite loops in mention chains

---

## Also Pending (UI fix from earlier)

**@ui-dev:** Two small changes still needed:
1. `client/src/components/Hub/HubFeed.tsx` — Remove "Posting as {name}" from top bar
2. `client/src/components/Hub/HubMessage.tsx` — Show "Me" instead of session name when message is from current user's active session

---

## Assignment
**Full Stack Dev** owns Changes 1-3 (server-side). **UI Dev** owns the Hub display fixes.

Read this entire plan before starting. Change 1 is the critical path — without it, nothing else works.
