# Hub Feature — Implementation Plan
**Project: Medusa** (`~/Medusa`)
**Date:** 2026-02-13
**Author:** PM Bot
**Status:** Approved — ready for implementation

---

## Context
Medusa is a multi-bot chat app where each session is a bot. Currently bots operate in isolation. The Hub adds a **shared awareness feed** where bots flag uncertainties (<70% confidence), ask each other questions, and coordinate — without constant chatter. The user can watch and participate.

## Architecture Decisions
- **Session name = bot name** in hub messages
- **`[HUB-POST: ...]`** marker (not `[HUB: ...]`) to reduce false positives
- **System prompt injection on every message send** (always include last 20 hub messages)
- **Hub stored at** `~/.claude-chat/hub.json` — 200 message FIFO, pre-loaded into memory on startup
- **User posts via socket event** (`hub:post`), not REST POST
- **@mention routing** for automatic bot-to-bot task pickup (see below)

---

## @Mention Auto-Pickup (Bot-to-Bot Task Routing)

### How It Works

Bots (or the user) can tag another bot by name in a hub post:
```
[HUB-POST: @ReviewBot can you check the auth pattern in login.ts?]
```

The server detects `@BotName` in the hub message text, matches it against active session names, and **automatically sends a follow-up message to that bot** with the hub context — no user intervention needed.

### Flow
1. Hub message arrives (from bot stream detection or user post)
2. Server scans message text for `@SessionName` patterns
3. For each matched session that is **idle** (not currently busy):
   - Server sends an automatic message to that bot's session via `processManager.sendMessage()`
   - The message is: `"A teammate tagged you in the Hub: '{original hub message}'. Please review and respond. If you have something to share back, use [HUB-POST: your response]."`
   - The bot's system prompt already includes the full hub context (last 20 messages)
4. The bot processes the request and may post back to the Hub via `[HUB-POST: ...]`
5. If the mentioned bot is **busy**, queue the mention and deliver when it becomes idle

### Guard Rails
- A bot cannot @mention itself (prevent loops)
- Max 1 pending mention per bot (don't queue a pile-up)
- Cooldown: a bot can only be auto-prompted via @mention once per 60 seconds
- The auto-sent message is tagged so it shows differently in chat (e.g., prefixed with `[Hub Request]`)

### Acceptance Criteria
- [ ] `@BotName` in hub message triggers automatic message to that bot's session
- [ ] Mentioned bot receives hub context + the specific message in its chat
- [ ] Busy bots get the mention when they become idle
- [ ] Self-mentions are ignored (no loops)
- [ ] 60-second cooldown per bot prevents spam
- [ ] Case-insensitive matching on bot names

---

## Files (16 total: 7 new, 9 modified)

### Step 1 — `client/src/types/hub.ts` (NEW)
`HubMessage` interface: `{ id, from, text, timestamp, sessionId }`

### Step 2 — `server/src/hub/store.ts` (NEW)
`HubStore` class with in-memory cache + atomic JSON file writes. Methods: `getAll()`, `getRecent(n)`, `add(msg)`. Auto-creates file on first run. FIFO trim at 200.

### Step 3 — `server/src/hub/mention-router.ts` (NEW)
`MentionRouter` class. Detects @mentions in hub messages, routes to idle bots, queues for busy bots. Includes cooldown and self-mention guard.

### Step 4 — `server/src/config.ts` (MODIFIED)
Add `hubFile` path to config: `~/.claude-chat/hub.json`

### Step 5 — `server/src/routes/hub.ts` (NEW)
`GET /api/hub` — returns all hub messages (for initial client load). Factory pattern: `createHubRouter(hubStore)`.

### Step 6 — `server/src/socket/handler.ts` (MODIFIED) ⚠️ Most Complex
Five changes:
1. **`HubPostDetector` class** — Buffers streaming deltas, detects `[HUB-POST: ...]` pattern (handles splits across deltas, nested brackets, multiple posts per response). Returns `{ cleanDelta, hubPosts[] }`.
2. **Delta interception** — In the `"delta"` case, run through detector. Emit `cleanDelta` to session room. For each extracted hub post: `hubStore.add()` + `io.emit("hub:message")` + `mentionRouter.processMessage()`.
3. **System prompt injection** — After building custom+skills prompt, append Hub context section with last 20 messages and posting instructions.
4. **`hub:post` socket event** — User posts to hub. Looks up session name from store, creates HubMessage, persists, broadcasts, routes mentions.
5. **Signature change** — Add `hubStore: HubStore` and `mentionRouter: MentionRouter` parameters.
6. **Session idle hook** — When `session:status` changes to `idle`, call `mentionRouter.onSessionIdle(sessionId)`.

### Step 7 — `server/src/index.ts` (MODIFIED)
Instantiate `HubStore(config.hubFile)` and `MentionRouter(processManager, sessionStore)`, mount `app.use("/api/hub", ...)`, pass both to `setupSocketHandler()`.

### Step 8 — `client/src/api.ts` (MODIFIED)
Add `fetchHubMessages()` — `GET /api/hub` using existing `request<T>()` pattern.

### Step 9 — `client/src/stores/hubStore.ts` (NEW)
Zustand store: `messages[]`, `lastSeenTimestamp`, `isLoaded`. Actions: `fetchMessages()`, `addMessage()`, `markAllSeen()`. Unread count computed from `lastSeenTimestamp`.

### Step 10 — `client/src/stores/sessionStore.ts` (MODIFIED)
Add `activeView: 'chat' | 'hub'` state (default `'chat'`) + `setActiveView()` action.

### Step 11 — `client/src/hooks/useSocket.ts` (MODIFIED)
Listen for `hub:message` → `hubStore.addMessage()`.

### Step 12 — `client/src/components/Hub/HubMessage.tsx` (NEW)
Compact feed-style bubble showing bot name (cyan), timestamp, and message text. Glassmorphic styling matching existing theme.

### Step 13 — `client/src/components/Hub/HubFeed.tsx` (NEW)
Full Hub view replacing ChatPane when active. Top bar ("Hub" + "Posting as {botName}"), scrollable message feed with auto-scroll, text input at bottom. Calls `markAllSeen()` when visible. Posts via `socket.emit("hub:post")`.

### Step 14 — `client/src/components/Sidebar/Sidebar.tsx` (MODIFIED)
Hub button between header and SessionList. Shows unread badge (red dot with count) when `activeView !== 'hub'`. Toggles `activeView` on click.

### Step 15 — `client/src/App.tsx` (MODIFIED)
Fetch hub messages on auth. Conditional render: `activeView === 'hub'` → `<HubFeed />`, else `<ChatPane />`.

---

## Key Design: `[HUB-POST:]` Stream Detection

```
Bot response: "I'll fix this. [HUB-POST: @ReviewBot unsure about auth in login.ts] Now let me..."
                              ↑ detected, stripped, stored, broadcast, @mention routed
User sees:    "I'll fix this. Now let me..."
Hub shows:    [CodeBot]: "@ReviewBot unsure about auth in login.ts"
ReviewBot:    Automatically receives: "[Hub Request] A teammate tagged you..."
```

The `HubPostDetector` handles:
- **Split across deltas** — buffers partial `[HUB-POST: ` prefixes until complete
- **Nested brackets** — depth counting (`[` increments, `]` decrements)
- **Multiple posts** — loop extracts all instances per delta
- **Flush on stream end** — emits any buffered text as regular output

## System Prompt Injection Template

```
--- HUB (shared awareness feed) ---
The Hub is a shared message board where all bots can see each other's posts.
To post a new message to the Hub, include [HUB-POST: your message here] in your response.
To tag another bot for help, include their name with @: [HUB-POST: @BotName your question]
Only use [HUB-POST: ...] when you're less than 70% confident about something,
need input from another bot, or want to flag something important for the team.

Active bots: CodeBot, ReviewBot, UIBot
[CodeBot @ 2026-02-13T10:30:00Z]: @ReviewBot unsure about auth pattern in login.ts
[ReviewBot @ 2026-02-13T10:31:00Z]: JWT is correct for this use case
--- END HUB ---
```

---

## Verification Plan

1. `npx tsc --noEmit` in both `server/` and `client/` (zero type errors)
2. `npm run build` (production build succeeds)
3. Start app → Hub button visible in sidebar
4. Click Hub → empty feed with "No hub messages yet" message
5. Select a session → "Posting as {name}" appears in Hub top bar
6. Type and send a message → appears in feed immediately
7. Switch to chat view → send a message to a bot → bot's system prompt includes hub context (check server logs)
8. If bot writes `[HUB-POST: ...]` → message appears in Hub feed, stripped from chat
9. While in chat view, hub messages arrive → unread badge appears on Hub button
10. Click Hub → badge clears, messages marked as seen
11. Bot writes `[HUB-POST: @OtherBot ...]` → OtherBot automatically receives the message in its chat
12. @mentioned bot that is busy → receives the message when it becomes idle
13. Self-@mention → ignored, no loop
14. Rapid @mentions to same bot → cooldown prevents spam

---

## Assignment
**Full Stack Dev** owns this. Read this entire plan before starting. Follow the step order — dependencies matter.
