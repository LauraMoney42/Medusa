# Send Messages to Busy Bots

## Problem Statement

Users cannot currently send messages to bots that are actively working on a task. When a bot is busy (processing a message), the UI blocks new input, forcing users to wait until the bot finishes before they can queue up the next instruction. This creates workflow friction — users often have multiple related instructions they want to send in sequence, but must wait for each to complete before sending the next.

## User Story

**As a** Medusa user
**I want** to send messages to bots even when they're busy
**So that** I can queue up multiple instructions without waiting, and the bot processes them sequentially without interruption

## Proposed Solution

Implement a message queueing system that allows users to send messages to busy bots. Messages are queued client-side and server-side, then delivered to the bot automatically when it becomes idle.

### User Experience

1. User types message to a busy bot and hits send
2. Message appears immediately in chat with "⏳ Queued" indicator (vector-style icon matching Medusa styling)
3. Multiple messages can be sent while bot is busy — all queue up in order
4. No warning dialog ("Bot is working...") — messages silently queue
5. When bot finishes current task and becomes idle, next queued message auto-delivers
6. "⏳ Queued" indicator changes to normal message styling upon delivery
7. Bot processes message normally, unaware of the queuing mechanism

### Technical Approach

**Client-side:**
- Modify `SessionView.tsx` to allow input even when `session.isBusy === true`
- Add `queuedMessages: Message[]` to session state
- Render queued messages with `status: 'queued'` indicator
- When bot status changes to idle, auto-send first queued message

**Server-side:**
- Add `messageQueue: Array<{text: string, images?: string[]}>` to session metadata in `ProcessManager`
- `POST /api/sessions/:id/message` endpoint:
  - If bot is busy: add to `messageQueue`, return 202 Accepted
  - If bot is idle: send immediately as normal, return 200 OK
- When bot finishes (process exits), check `messageQueue`:
  - If empty: emit `session:status` with `isBusy: false`
  - If has messages: auto-send next message, keep `isBusy: true`

**Queue Processing:**
- FIFO order (first-in-first-out)
- Automatic delivery — no user action required
- Queue persists in memory only (cleared on server restart)

## Scope

### In Scope
- ✅ Client-side message queueing UI (⏳ indicator, no blocking)
- ✅ Server-side queue management in `ProcessManager`
- ✅ Automatic delivery when bot becomes idle
- ✅ Multiple messages queue up sequentially
- ✅ Vector-style "⏳ Queued" icon matching Medusa design

### Out of Scope
- ❌ Queue persistence across server restarts (future enhancement)
- ❌ Queue length limits (assume reasonable use <10 messages)
- ❌ Queue editing/reordering (once sent, message is locked in queue)
- ❌ Queue visibility in sidebar (queued count badge — future P2)
- ❌ "Cancel queued message" functionality (future P2)

## Task Breakdown

### Task 1: Client-side UI Updates
**File:** `client/src/components/SessionView/SessionView.tsx`
**Owner:** UI Dev
**Effort:** Small (~50 lines)

- Remove `disabled={session.isBusy}` check on message input
- Add `queuedMessages` to session state
- Render messages with `status === 'queued'` using ⏳ icon
- Listen for `session:status` change to idle → auto-send first queued message
- Update message status from 'queued' to 'sent' upon delivery

### Task 2: Message Type Extension
**File:** `client/src/types/message.ts`
**Owner:** UI Dev
**Effort:** Trivial (~5 lines)

- Add `status?: 'queued' | 'sent' | 'delivered'` to `Message` type
- Default to 'sent' for backward compatibility

### Task 3: Server-side Queue Management
**File:** `server/src/claude/process-manager.ts`
**Owner:** Backend Dev
**Effort:** Medium (~100 lines)

- Add `messageQueue: QueuedMessage[]` to `SessionMetadata` interface
- Modify `sendMessage()`:
  - If session has active process: add to queue, return early
  - If session idle: send immediately as normal
- Add `processNextQueuedMessage(sessionId)` helper
- Call `processNextQueuedMessage()` when process exits
- Emit `session:status` with `queuedCount` for future UI badge support

### Task 4: API Endpoint Update
**File:** `server/src/index.ts` (message route handler)
**Owner:** Backend Dev
**Effort:** Small (~20 lines)

- Update `POST /api/sessions/:id/message` response:
  - Return 202 Accepted if message queued
  - Return 200 OK if message sent immediately
- Include `{queued: true, position: N}` in response body for queued messages

### Task 5: Socket Event Updates
**File:** `server/src/index.ts` (Socket.IO handlers)
**Owner:** Full Stack Dev
**Effort:** Small (~30 lines)

- Add `queuedCount` field to `session:status` event payload
- Client listens for `queuedCount > 0` to show future badge UI
- Emit updated status when queue length changes

### Task 6: Queued Message Icon (Vector SVG)
**File:** `client/src/components/SessionView/MessageList.tsx`
**Owner:** UI Dev
**Effort:** Trivial (~15 lines)

- Create inline SVG for ⏳ hourglass icon (vector, matches Medusa style)
- Render next to message timestamp when `message.status === 'queued'`
- Use color: `#9ca3af` (gray-400) for subtle "waiting" state

## Acceptance Criteria

### Client Behavior
- [ ] Given a bot is busy, when I type a message and hit send, then the message appears immediately with "⏳ Queued" indicator
- [ ] Given I've sent 3 messages to a busy bot, when the bot finishes its current task, then the first queued message auto-delivers
- [ ] Given a message is queued, when it gets delivered, then the ⏳ indicator disappears and message appears as normal
- [ ] Given I send messages to a busy bot, when I do so, then no warning dialog appears (silent queueing)

### Server Behavior
- [ ] Given a bot is busy, when I POST a message to `/api/sessions/:id/message`, then server returns 202 Accepted with `{queued: true, position: N}`
- [ ] Given a bot is idle, when I POST a message, then server returns 200 OK and sends immediately
- [ ] Given a bot finishes a task with 2 queued messages, when the first message completes, then the second message auto-delivers
- [ ] Given the server restarts, when it starts up, then queued messages are lost (acceptable limitation for MVP)

### Edge Cases
- [ ] Given a bot crashes mid-task with queued messages, when it crashes, then queue is cleared and user is notified
- [ ] Given I queue 10 messages, when the bot becomes idle, then all 10 process sequentially in FIFO order
- [ ] Given a bot has queued messages, when I stop the session, then queue is cleared and stop proceeds normally

## Success Criteria

**Outcomes, not outputs:**
- Users can send 3+ sequential instructions to a busy bot without waiting
- Zero complaints about "bot is working" blocking workflow
- Message delivery order matches send order 100% of the time
- No regressions in normal (non-queued) message flow

## Open Questions

1. **Queue length limit?** Should we cap at N messages (e.g., 10) to prevent abuse?
   → **Decision:** No limit for MVP. Monitor usage. Add if needed.

2. **Queue persistence?** Should queue survive server restart?
   → **Decision:** No for MVP. File-based persistence adds complexity. Acceptable loss.

3. **Cancel queued message?** Should users be able to delete from queue?
   → **Decision:** Not for MVP. Add in P2 if requested.

4. **Visual queue count badge?** Show "(3 queued)" next to bot name in sidebar?
   → **Decision:** Yes, good idea for future. Not blocking for MVP. Add to backlog as P2.

5. **Toast notification on queue?** Should we show a toast "Message queued (2 in queue)" when user sends?
   → **Decision:** No. Silent queueing per user requirement. Queued indicator in chat is sufficient.

## Dependencies

- None — independent feature, no blockers

## Risks

**Low Risk:**
- Queue logic is simple FIFO, low complexity
- Client-side changes are UI-only, non-breaking
- Server-side changes are additive, backward compatible

**Mitigation:**
- Test with 5+ queued messages to ensure delivery order
- Test bot crash scenario to verify queue cleanup
- Verify no memory leaks with large queue counts (stress test with 50+ messages)

## Timeline Estimate

- **Total effort:** 1-2 hours (Small feature, well-scoped)
- **Task 1-2 (Client):** 30 minutes (UI Dev)
- **Task 3-4 (Server):** 45 minutes (Backend Dev)
- **Task 5 (Socket events):** 15 minutes (Full Stack Dev)
- **Task 6 (Icon):** 10 minutes (UI Dev)
- **Testing:** 20 minutes (Manual QA by PM)

## Testing Plan

**Manual QA Steps:**
1. Start Medusa, create bot session
2. Send message, immediately send 3 more while bot is processing
3. Verify all 4 messages appear in chat (1 normal, 3 with ⏳)
4. Wait for bot to finish — verify messages deliver in order
5. Send message to idle bot — verify no queue, sends immediately
6. Queue 5 messages, stop session — verify queue cleared
7. Queue 3 messages, restart server — verify queue lost (expected)

**Acceptance:** All 7 test cases pass.
