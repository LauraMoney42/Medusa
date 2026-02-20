# Feature: Auto-Resume Interrupted Tasks

**Priority:** P1
**Dependency:** Graceful Shutdown (COMPLETE)
**Status:** Spec complete — awaiting Full Stack Dev assignment

---

## Problem Statement

Even with graceful shutdown (30s drain), bots mid-task when the timeout expires lose their in-progress work. After restart, there is no mechanism to re-trigger interrupted tasks. Users must manually re-assign work — often without knowing which bots were interrupted or what they were doing.

## User Story

**As a** user who restarted Medusa while bots were working,
**I want** interrupted bots to automatically pick up where they left off,
**So that** I don't have to manually track and re-assign lost work.

---

## Proposed Solution

Before forced shutdown (when drain timeout expires), persist which sessions were still in-progress and what message triggered their work. On startup, detect that file, re-trigger those sessions with the original message, then clean up the state file.

**Key decisions (resolved):**

1. **State file format:** JSON at `~/.claude-chat/interrupted-sessions.json`. Structure:
   ```json
   [
     {
       "sessionId": "abc123",
       "botName": "Full Stack Dev",
       "lastMessageId": "msg_xyz",
       "lastMessageText": "Please implement the auth endpoint...",
       "interruptedAt": "2026-02-18T04:30:00.000Z"
     }
   ]
   ```

2. **Re-trigger approach:** Re-send the original user message text (not a "please continue" message). Re-triggering from scratch is simpler and avoids context window confusion. The bot will re-read the conversation and produce a fresh response.

3. **Context window:** No special handling. The bot re-reads its session history on resume — same as any normal response. If the session is too long, the bot will handle it naturally.

4. **Idle sessions at shutdown:** Only sessions with `status === 'busy'` at shutdown time are persisted. Idle sessions are ignored.

---

## Scope

**In:**
- Persist interrupted session state to `~/.claude-chat/interrupted-sessions.json` before forced shutdown
- On server startup, detect and read that file
- Auto-re-trigger interrupted messages for the affected sessions
- Post a Hub message: "Resuming interrupted work for [bot name]"
- Clean up the state file after successful resume

**Out:**
- Resuming from mid-stream (we re-trigger from scratch, not mid-token)
- Recovering partial output from the interrupted response
- Any changes to the graceful shutdown drain period
- UI changes — this is backend-only

---

## Success Criteria

- Zero manual re-assignments needed after a restart that interrupts active bots
- Hub clearly communicates which bots were resumed and what work was resumed

---

## Tasks

### AR1 — Persist interrupted session state on forced shutdown
**Assigned to:** Full Stack Dev
**File:** `server/src/index.ts` (graceful shutdown sequence)

When the graceful shutdown drain timeout expires and sessions are still busy, before `process.exit()`:
1. Query all sessions with `status === 'busy'`
2. For each, capture: `sessionId`, `botName`, `lastMessageId`, `lastMessageText`, `interruptedAt`
3. Write to `~/.claude-chat/interrupted-sessions.json` (overwrite, not append)
4. Then exit

If all sessions finish within the drain period (clean shutdown), do NOT write the file (or delete it if it exists).

**Acceptance Criteria:**
- [ ] Given a bot is busy when shutdown timeout fires, then `interrupted-sessions.json` is written before `process.exit()`
- [ ] Given all bots finish cleanly within 30s, then `interrupted-sessions.json` is NOT created (or is deleted)
- [ ] Given multiple busy bots, then all are written to the file
- [ ] File format matches spec above (sessionId, botName, lastMessageId, lastMessageText, interruptedAt)
- [ ] `npx tsc --noEmit` passes, `npm run build` succeeds

---

### AR2 — Startup detection + auto-re-trigger
**Assigned to:** Full Stack Dev
**File:** `server/src/index.ts` (startup sequence)

On server startup, after sessions are initialized:
1. Check if `~/.claude-chat/interrupted-sessions.json` exists
2. If yes, read the file and for each entry:
   - Find the matching session by `sessionId`
   - Re-send `lastMessageText` to that session (same as a normal user message)
   - Log the resume action
3. Delete `interrupted-sessions.json` after all re-triggers are queued (regardless of success — prevents infinite re-trigger loop)

If the session no longer exists (deleted between shutdown and restart), skip it silently.

**Acceptance Criteria:**
- [ ] Given `interrupted-sessions.json` exists on startup, then each listed session receives the original message
- [ ] Given the file exists, then it is deleted after re-triggers are queued (not after completion)
- [ ] Given a session in the file no longer exists, then it is skipped silently (no crash)
- [ ] Given no interrupted state file, then startup proceeds normally — no change in behavior
- [ ] `npx tsc --noEmit` passes, `npm run build` succeeds

---

### AR3 — Hub notification on resume
**Assigned to:** Full Stack Dev
**File:** `server/src/index.ts` (startup sequence, after AR2)

For each successfully re-triggered session, post a Hub message:

```
Resuming interrupted work for [botName]: "[lastMessageText truncated to 80 chars]..."
```

If multiple bots are resumed, post one Hub message per bot (not a batched message).

**Acceptance Criteria:**
- [ ] Given a bot is auto-resumed, then a Hub message is posted within 5s of server startup
- [ ] Hub message names the bot and previews the task (truncated to 80 chars if long)
- [ ] Given no bots were interrupted, then no Hub message is posted
- [ ] Given 3 bots were interrupted, then 3 Hub messages are posted (one per bot)
- [ ] `npx tsc --noEmit` passes, `npm run build` succeeds

---

## Implementation Notes

- AR1, AR2, AR3 are **sequential** — AR2 depends on AR1's file format, AR3 depends on AR2's resume logic
- All 3 can be shipped in a single PR — they're tightly coupled
- No frontend changes required
- No new dependencies required
- State file location: `path.join(process.env.HOME || '~', '.claude-chat', 'interrupted-sessions.json')` — consistent with `projects.json` location pattern

---

## QA Verification

After all 3 tasks ship:
- [ ] Start a task on a bot (send a long-running request)
- [ ] While bot is busy, kill the server forcefully (not graceful — kill -9 or equivalent)
- [ ] Verify `~/.claude-chat/interrupted-sessions.json` was written with correct session data
- [ ] Restart the server
- [ ] Verify the bot automatically re-receives its interrupted task
- [ ] Verify Hub message appears: "Resuming interrupted work for [bot]..."
- [ ] Verify `interrupted-sessions.json` is deleted after restart
- [ ] Restart server again — verify no spurious re-triggers (file is gone)
- [ ] `npm run build` GREEN
