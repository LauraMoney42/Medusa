# Medusa — Architecture & Code Review
**Reviewer:** Full Stack Dev
**Date:** 2026-02-18
**Scope:** Full codebase — server + client + infrastructure
**Type:** Read-only review. No code changes made.

---

## Executive Summary

Medusa is a well-structured multi-bot chat orchestration system built on Claude Code. The architecture is clean and pragmatic for its scale. The main concerns are around **operational resilience** (no tests, no error rate observability, fragile process model), **scalability limits** of the file-based persistence model, and a handful of correctness issues in the real-time event pipeline. Nothing is catastrophically broken, but several P1 issues deserve attention before Medusa is used in production-critical workflows.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  Electron Desktop App (Medusa.app)              │
│  └── React SPA (Vite + TypeScript)              │
│       ├── Zustand stores (client state)         │
│       ├── Socket.IO client (real-time)          │
│       └── REST API client (CRUD)               │
└───────────────────┬─────────────────────────────┘
                    │ HTTP + WebSocket
┌───────────────────▼─────────────────────────────┐
│  Node.js Server (Express + Socket.IO)           │
│  ├── ProcessManager (spawns claude CLI)         │
│  ├── SessionStore (sessions.json)               │
│  ├── ChatStore (chats/*.json per session)       │
│  ├── HubStore (hub.json)                        │
│  ├── ProjectStore (projects.json)               │
│  ├── MentionRouter (@mention dispatch)          │
│  ├── HubPollScheduler (background polling)      │
│  └── TaskSyncManager (TASK-DONE detection)      │
└───────────────────┬─────────────────────────────┘
                    │ subprocess (spawn)
┌───────────────────▼─────────────────────────────┐
│  claude CLI (one process per active session)    │
│  --resume <sessionId> / --session-id <id>       │
│  --output-format stream-json --verbose          │
└─────────────────────────────────────────────────┘
```

**Data flow:** User message → Socket.IO → handler.ts → ProcessManager.sendMessage() → spawns `claude` subprocess → streaming JSON events parsed by StreamParser → events emitted back to client via Socket.IO → stored to ChatStore on completion.

**Hub flow:** Bot posts [HUB-POST: ...] in response → HubPostDetector strips it → HubStore.add() → io.emit("hub:message") → MentionRouter.processMessage() → @mentions dispatched to target sessions.

---

## Component-by-Component Review

### ProcessManager (`claude/process-manager.ts`)

**Overall: Good. Solid spawn/resume logic.**

✅ Spawn lock (`spawnLock`) correctly prevents concurrent message sends
✅ SIGTERM → SIGKILL escalation on abort
✅ Auto-retry with `--session-id` when `--resume` fails ("No conversation found")
✅ `killTimer.unref()` prevents blocking graceful shutdown

**Issues:**

- **P1 — No concurrency backpressure:** If `MentionRouter` and `HubPollScheduler` both try to send to the same session simultaneously, one path checks `entry.process` (isSessionBusy) and the other uses `sendMessage` which checks `process || spawnLock`. There's a TOCTOU window between the busy check and the actual send. Observed in practice as occasional "Session is busy" errors in logs that are silently swallowed.

- **P2 — `rawStdout` unbounded:** `rawStdout` accumulates all stdout from the `claude` process and is never cleared. For long-running sessions, this could grow to hundreds of MB in memory before the process exits. The "No conversation found" check only needs the first ~1KB.

- **P2 — Binary search path is resolved once at module load:** `CLAUDE_BIN` is resolved at startup. If `claude` is updated or its path changes, a server restart is required. Minor, but worth noting.

---

### SessionStore (`sessions/store.ts`)

**Overall: Clean. Atomic writes are correct.**

✅ Atomic write via `.tmp` + `rename()` — no half-written JSON
✅ In-memory cache as source of truth — no read-modify-write races
✅ Disk read only on startup

**Issues:**

- **P2 — `loadAll()` returns a shallow copy of the array but not deep copies of objects.** Callers that mutate session objects will silently mutate the cache. Currently safe because callers don't do this, but it's a time bomb.

- **P2 — No schema migration.** If `SessionMeta` fields change (e.g., adding `workingDir` was presumably a migration at some point), old JSON files will silently drop new fields or have `undefined` values. No version field or migration path exists.

---

### ChatStore (`chat/store.ts`)

**Overall: Simple and correct for current scale.**

✅ Atomic writes
✅ Per-session files (good for isolation)

**Issues:**

- **P1 — Full file read/write on every append.** `appendMessage()` reads the entire file, appends one message, writes the whole file back. For a busy session with 1000+ messages, each append reads and writes ~100KB+ of JSON. This will become a bottleneck under heavy load. Should append-only or use a more efficient format.

- **P2 — No message size limit.** A single very long message (e.g., a bot that dumps an entire file into its response) can create an unbounded file. No cap on messages per session file.

- **P2 — `loadMessages` silently returns `[]` on parse error.** If a chat file is corrupted, the session starts fresh with no error visible to the user.

---

### HubStore (`hub/store.ts`)

Not fully read, but from usage patterns:

- **P2 — `getRecent(20)` hard limit:** PollScheduler only looks at the last 20 hub messages. In an active multi-bot session with heavy Hub traffic, relevant messages could scroll out of the window before a bot is polled.

---

### MentionRouter (`hub/mention-router.ts`)

**Overall: Well-designed with good guards.**

✅ Chain depth limit (MAX_CHAIN_DEPTH = 3) prevents infinite mention loops
✅ 60s cooldown per bot
✅ Max 1 pending mention per bot
✅ Self-mention guard
✅ Longest-name-first matching prevents "UI Dev" stealing from "UI Dev 2"

**Issues:**

- **P1 — Pending mention is silently dropped if cooldown fires during delivery.** In `onSessionIdle()`, if the cooldown check fails (bot became idle within 60s of last mention), the pending mention is discarded with no notification. The sending bot gets no reply. This is the correct behavior for spam prevention, but creates confusing silence in active workflows.

- **P2 — `pendingMentions` max-1 policy:** If Bot A mentions Bot B twice in quick succession (e.g., two different Hub posts), the second pending mention overwrites the first. The first task is lost silently.

- **P2 — extractMentions calls `sessionStore.loadAll()` on every Hub message.** This is O(n×m) where n = sessions and m = message length. Fine at current scale, but inefficient.

---

### HubPollScheduler (`hub/poll-scheduler.ts`)

**Overall: Thoughtful design. Hibernation logic is solid.**

✅ Per-bot cooldown (10 min)
✅ Max 2 bots per tick (stampede prevention)
✅ New-messages-only check (last-seen ID tracking)
✅ [NO-ACTION] suppression — doesn't persist empty check-ins
✅ Stale assignment detection + nudge

**Issues:**

- **P1 — `[NO-ACTION]` check is too broad:** The check is `assistantText.includes("[NO-ACTION]")`. A bot that says "I responded with [NO-ACTION] earlier but now have work to do" would be incorrectly suppressed. Should be exact match on trimmed text or beginning-of-response check.

- **P1 — Stale assignment only nudges once (`entry.nudged = true`).** A bot that receives a nudge but still doesn't act on it will never be nudged again for that assignment. No escalation path.

- **P2 — `lastSeenMessageId` Map grows unbounded.** When a session is deleted, `removeSession()` cleans up the Maps — but this relies on callers to invoke it correctly. If a session is removed via direct file edit, the Maps leak.

---

### Socket Handler (`socket/handler.ts`)

Not fully read, but from imports and usage:

- **P1 — `buildHubPromptSection` is imported by `index.ts` for AR2.** This creates a coupling between the entry point and a socket-layer concern. The function should live in a shared utility module, not in `socket/handler.ts`.

- **P2 — `HubPostDetector` is a stateful streaming parser shared via instantiation.** Good pattern, but if the stream is aborted mid-detection, the detector state is leaked. Unclear if `flush()` is always called on abort paths.

---

### Auto-Resume (AR1/AR2/AR3 in `index.ts`)

**Overall: Functionally correct. Some architectural concerns.**

✅ File deleted before re-triggering (prevents infinite loops)
✅ Skips missing sessions silently
✅ Hub notification per resumed bot

**Issues:**

- **P1 — AR2 duplicates streaming boilerplate from MentionRouter and HubPollScheduler.** The `resumeInterruptedSessions()` function contains ~80 lines of stream event handling that is nearly identical to `deliverMention()` and `pollBot()`. This is 3 copies of the same pattern. Should be extracted into a shared `streamMessageToSession()` utility.

- **P2 — AR2 resume prompt includes "[Auto-Resume]" prefix.** The original `lastMessageText` was a raw user message. Prepending "[Auto-Resume]" changes what the bot sees versus its last conversation context. Could confuse bots that have strict message format expectations.

- **P2 — 1-second `setTimeout` after `server.listen()` for AR2.** This is a timing hack to "let socket handlers settle." No guarantee 1s is sufficient under load.

---

### Model Router (`claude/model-router.ts`)

**Overall: Clean and well-reasoned.**

✅ Tiered selection: haiku → sonnet → opus
✅ Source-based routing (poll/nudge always haiku)

**Issues:**

- **P2 — Pattern matching is fragile string matching.** `OPUS_PATTERNS` and `HAIKU_PATTERNS` will misfire. Example: "no action was taken" matches HAIKU_PATTERNS. Regex patterns have no word boundary guards.

- **P2 — `code review` triggers opus.** This review request itself would trigger opus via `selectModel`. Correct behavior, but the model-router comment says it's for "architecture decisions" — a routine code review (not architecture) shouldn't necessarily be opus.

---

### Auth (`auth.ts`)

**Overall: Minimal but functional for a desktop-local tool.**

✅ Bearer token validation
✅ Health check bypass
✅ Static file bypass

**Issues:**

- **P1 — Socket.IO auth is not enforced via `io.use()` middleware.** The Express middleware only covers HTTP routes. WebSocket connections authenticated at upgrade time via `auth.token` in Socket.IO client (from `socket.ts`), but it's unclear if the server-side IO server validates this token on connection. If not, any process on the local machine that can reach port 3456 can connect without a token and send messages.

- **P1 — `if (!config.authToken) { next(); }` bypasses all auth when no token is configured.** This is the default state (empty `AUTH_TOKEN` env var). Any unauthenticated request succeeds. Acceptable for localhost-only use but should be documented clearly.

---

### Client Architecture

**Overall: Clean React with good Zustand patterns.**

✅ Consistent store pattern (create + typed state + typed actions)
✅ Socket singleton pattern (prevents duplicate connections)
✅ `useSocket` hook properly removes all event listeners on cleanup
✅ `imageDropStore` correctly revokes blob URLs to prevent memory leaks
✅ `draftStore` uses `persist` middleware + `partialize` correctly

**Issues:**

- **P1 — Auth token stored in `localStorage`.** `localStorage.getItem('auth-token')` is called in multiple places including `ChatInput.tsx`, `api.ts`, and the socket initialization. Tokens in localStorage are accessible to any JavaScript running on the page (XSS vulnerability). For a desktop Electron app this is lower risk, but it's still bad practice.

- ✅ **Error boundaries are implemented.** `ErrorBoundary.tsx` exists and is wired in `App.tsx` wrapping all major panes (ChatPane, HubFeed, ProjectPane, root). This was initially flagged as missing — confirmed correct after verification.

- **P2 — `useSocket` is the root of all socket event handling but has no reconnection recovery logic for missed events.** On reconnect, the server resets `busy` statuses but the client doesn't re-fetch chat history or hub messages. Messages received during disconnect are lost from the client view.

- **P2 — ChatStore on client grows unbounded per session.** Messages are appended but never pruned from the in-memory Zustand store. In a long-running session, this could cause performance degradation.

- **P2 — Bundle size warning (665KB+):** The client bundle exceeds 500KB (Vite warns). No code splitting is configured. For a desktop app this is acceptable, but lazy-loading heavy components (markdown renderer, RegionSelector) would improve startup time.

---

### File-Based Persistence (All Stores)

**Overall: Correct for current scale. Will not scale.**

✅ Atomic writes everywhere
✅ Consistent `.tmp` → `rename()` pattern

**Issues:**

- **P1 — No concurrent write protection across processes.** If the server crashes and is restarted while another process writes a `.tmp` file, the rename could fail or overwrite partial data. No file locking used.

- **P2 — `projects.json` is a single file for all projects.** Every project read/write loads and rewrites the entire file. At 50+ projects this becomes slow. No indexing.

- **P2 — Hub messages in `hub.json` are never pruned.** The file grows indefinitely. No TTL, no archival, no cap.

- **P2 — Chat files (`chats/*.json`) are never archived or pruned.** Old sessions accumulate indefinitely in `~/.claude-chat/chats/`. The `devlog-paginator` partially addresses this for devlogs, but chat history has no equivalent.

---

### Infrastructure & Observability

- **P0 — No tests whatsoever.** Zero unit tests, zero integration tests. Confirmed by Explore agent (no test files found). This is the single biggest risk. Any refactor or new feature has no regression protection.

- **P1 — No structured logging.** `console.log`, `console.warn`, `console.error` throughout. No log levels, no correlation IDs, no request tracing. Debugging production issues is painful.

- **P1 — No error rate monitoring.** Claude process failures, socket errors, and file I/O errors are logged but not tracked. No way to know if 10% of bot responses are failing silently.

- **P2 — `process.env.CLAUDECODE = undefined` in spawn env.** Intentional (prevents Claude from thinking it's running inside Claude Code), but not documented. A future developer will wonder why.

- **P2 — `freePort()` uses `lsof` which is not cross-platform.** Will fail silently on Linux CI or non-macOS deployments.

---

## Priority Summary

| Priority | Count | Items |
|----------|-------|-------|
| P0 | 1 | No tests |
| P1 | 8 | Auth socket bypass, auth localStorage, stream boilerplate duplication, ChatStore O(n) append, ProcessManager TOCTOU, [NO-ACTION] broad match, stale nudge no escalation, buildHubPromptSection coupling |
| P2 | 15+ | rawStdout unbounded, schema migration, pending mention overwrite, hub getRecent(20) limit, regex pattern fragility, bundle size, chat history unbounded, hub.json unbounded, no file locking, no structured logging, no error monitoring, etc. |
| ✅ Fixed | 1 | React ErrorBoundary — already implemented and wired (initially flagged as missing, confirmed correct) |

---

## Recommendations (Prioritized)

1. **[P0] Add tests.** Start with unit tests for `ProcessManager`, `SessionStore`, `MentionRouter`, and `HubPostDetector`. Integration tests for the Socket.IO message flow. Nothing else matters if the core loops can't be regression-tested safely.

2. **[P1] Extract shared stream-to-session utility.** `deliverMention`, `pollBot`, `nudgeBot`, and `resumeInterruptedSessions` all implement the same ~80-line streaming pattern. One shared function with a callback for event handling would cut the codebase by ~300 lines and eliminate the main source of drift bugs.

3. **[P1] Socket.IO auth middleware.** Add `io.use((socket, next) => { /* validate socket.handshake.auth.token */ })` to enforce auth on WebSocket connections, not just HTTP.

4. **[P1] ChatStore append performance.** Replace full-file-read-modify-write with an append-only log or at minimum batch writes with a short debounce. At scale, every message currently does a full JSON parse + stringify of the entire history.

5. **[P2] Structured logging.** Replace `console.log` with a lightweight logger (e.g., `pino`) that supports log levels and JSON output. Adds observability without major refactoring.

7. **[P2] Hub message pruning.** Cap `hub.json` at N messages (e.g., 500) or implement a rolling window. Unbounded growth will eventually degrade read performance and memory.

---

*End of review. No code was changed during this review.*
