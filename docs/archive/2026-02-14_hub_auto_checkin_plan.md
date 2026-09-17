# Hub Auto Check-In System — Plan
**Project: Medusa** (`~/Medusa`)
**Date:** 2026-02-14
**Author:** PM Bot
**Assign to:** @Full Stack Dev
**Priority:** High — this is what makes the Hub actually useful

---

## Current State

A lot is already built. Here's the audit:

| Feature | Status | Notes |
|---------|--------|-------|
| `poll-scheduler.ts` | ✅ Built | Background polling, 10-min cooldown, max 2 bots/tick |
| `mention-router.ts` | ✅ Built | Full streaming, chain routing (depth 3), busy queue |
| `POST /api/hub` | ✅ Built | External tools can post |
| Config vars | ✅ Built | `HUB_POLLING`, `HUB_POLL_INTERVAL_MS` |
| Wired in `index.ts` | ✅ Built | Starts on boot if `HUB_POLLING=true` |
| **Polling is actually enabled** | ❌ NOT ENABLED | `.env` has no `HUB_POLLING=true` |
| **@mention handles multi-word bot names** | ❌ BROKEN | Regex `/@([\w-]+)/gi` only matches single words. A bot named "Full Stack Dev" would only match "Full" |
| **Poll prompt is too vague** | ⚠️ WEAK | "Review the Hub for any items that need your attention" — bot has no idea what's new since last check |
| **No "last seen" tracking** | ❌ MISSING | Bots get re-prompted about messages they already responded to |
| **No immediate @mention for user posts** | ⚠️ WORKS but delayed | If user types `@ui-dev fix this` in Hub, it routes via `hub:post` socket → `mentionRouter.processMessage()` — this part works. But the mention regex won't match multi-word names |

---

## What Needs to Happen

### Fix 1: Enable polling in `.env`

**File:** `.env`

Add:
```
HUB_POLLING=true
HUB_POLL_INTERVAL_MS=120000
```

That's it. The scheduler is already wired up — it just needs to be turned on.

### Fix 2: Multi-word bot name matching in @mentions

**File:** `server/src/hub/mention-router.ts` — `extractMentions()`

**Problem:** Current regex `/@([\w-]+)/gi` only matches `@word`. Bot names like "Full Stack Dev", "UI Dev", "Product Manager" won't match.

**Fix:** Don't use regex for extraction. Instead, scan the message text for each active session name after the `@` symbol.

```typescript
private extractMentions(text: string): string[] {
  const allSessions = this.sessionStore.loadAll();
  const mentioned: string[] = [];

  const lowerText = text.toLowerCase();

  for (const session of allSessions) {
    const namePattern = `@${session.name.toLowerCase()}`;
    if (lowerText.includes(namePattern)) {
      mentioned.push(session.name);
    }
  }

  return mentioned;
}
```

This handles:
- `@ui-dev` → matches session named "ui-dev"
- `@UI Dev` → matches session named "UI Dev"
- `@Full Stack Dev` → matches session named "Full Stack Dev"
- Case-insensitive

**Edge case:** If a bot is named "Dev" and another is named "Full Stack Dev", `@Full Stack Dev` should match the longer name, not just "Dev". Sort session names by length (longest first) and stop after first match per position.

### Fix 3: Smart polling with "last seen" tracking

**File:** `server/src/hub/poll-scheduler.ts`

**Problem:** The poll prompt says "review the Hub" but the bot has no idea what's new. It might respond to the same message every poll cycle. Wasteful and confusing.

**Fix:** Track the last hub message ID each bot has "seen" (i.e., was included in their system prompt). On each poll tick, only prompt bots if there are **new messages since their last check**.

Add to `HubPollScheduler`:
```typescript
/** sessionId -> last hub message ID the bot was polled about */
private lastSeenMessageId = new Map<string, string>();
```

In `tick()`:
```typescript
// Get messages since this bot's last seen
const recentMessages = this.hubStore.getRecent(20);
const lastSeenId = this.lastSeenMessageId.get(session.id);

// Find the index of the last seen message
const lastSeenIdx = lastSeenId
  ? recentMessages.findIndex(m => m.id === lastSeenId)
  : -1;

// Only poll if there are new messages after the last seen
const newMessages = recentMessages.slice(lastSeenIdx + 1);
if (newMessages.length === 0) continue;

// Update last seen to current latest
this.lastSeenMessageId.set(session.id, recentMessages[recentMessages.length - 1].id);
```

Also update the poll prompt to be more specific:
```typescript
const newCount = newMessages.length;
const prompt = `[Hub Check] There are ${newCount} new message(s) in the Hub since your last check. Review them in the Hub context above. If any are relevant to your role or expertise, respond via [HUB-POST: your response]. If nothing needs your attention, simply say "Nothing for me." and move on.`;
```

### Fix 4: Don't poll bots about their own messages

**File:** `server/src/hub/poll-scheduler.ts`

In `tick()`, when checking new messages, filter out messages from the bot being polled:
```typescript
const relevantNew = newMessages.filter(m => m.sessionId !== session.id);
if (relevantNew.length === 0) continue;
```

No point nudging a bot about messages it wrote itself.

### Fix 5: Reduce "nothing for me" noise

**Problem:** If the poll prompt tells bots to say "Nothing for me" when nothing is relevant, that response clutters the bot's chat history. Every 2 minutes you'd see `[Hub Check]` → "Nothing for me." repeated endlessly.

**Fix:** Add a special flag to the poll prompt telling the bot to respond with a specific short marker if nothing is relevant:

```typescript
const prompt = `[Hub Check] There are ${newCount} new message(s) in the Hub since your last check. Review them in the Hub context above. If any are relevant to your role or expertise, respond via [HUB-POST: your response]. If nothing needs your attention, respond with exactly: [NO-ACTION]`;
```

In `pollBot()`'s `onEvent` handler, when the full response is collected, check if it contains `[NO-ACTION]`. If so, **don't persist the assistant message to chat history** — just silently discard it. The bot checked in, found nothing, and we don't clutter the conversation.

Add to the `.then()` block:
```typescript
// Don't persist no-action responses (reduces noise)
const isNoAction = assistantText.trim() === "[NO-ACTION]"
  || assistantText.includes("[NO-ACTION]");

if (!isNoAction) {
  this.chatStore.appendMessage({ ... });
}
```

Also don't persist the `[Hub Check]` user prompt if the response was no-action:
```typescript
// Move chatStore.appendMessage(userMsg) to AFTER we know the response
// Only persist the exchange if the bot actually had something to say
```

This means restructuring `pollBot()` slightly:
1. Emit `message:user` and `message:stream:start` to the session room (so it's visible live if watching)
2. But only call `chatStore.appendMessage()` for both user + assistant **after** the stream completes and **only if** the response isn't `[NO-ACTION]`

---

## Summary of Changes

| # | File | Type | Change |
|---|------|------|--------|
| 1 | `.env` | MODIFIED | Add `HUB_POLLING=true` and `HUB_POLL_INTERVAL_MS=120000` |
| 2 | `server/src/hub/mention-router.ts` | MODIFIED | Fix `extractMentions()` for multi-word bot names |
| 3 | `server/src/hub/poll-scheduler.ts` | MODIFIED | Add last-seen tracking, skip own messages, no-action handling, smarter prompt |
| 4 | `server/src/hub/store.ts` | POSSIBLY MODIFIED | May need a `getMessagesSince(id)` helper if useful |

---

## Acceptance Criteria

### Polling
- [ ] `HUB_POLLING=true` in `.env` and server logs confirm polling is active on boot
- [ ] Idle bots get polled every 2 minutes (configurable)
- [ ] Bots are NOT polled when no new hub messages exist since their last check
- [ ] Bots don't get polled about their own messages
- [ ] `[NO-ACTION]` responses are not persisted to chat history
- [ ] Per-bot 10-minute cooldown prevents over-polling
- [ ] Max 2 bots per tick

### @mention routing
- [ ] `@UI Dev` matches a session named "UI Dev" (multi-word)
- [ ] `@Full Stack Dev` matches correctly, doesn't partial-match "Dev" if both exist
- [ ] Case-insensitive matching
- [ ] @mentioned bot receives the message immediately (or when idle)
- [ ] Response streams to session room and hub posts appear in Hub feed

### General
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds
- [ ] Server starts without errors
- [ ] Bots that have nothing to contribute stay quiet (no noise)

---

## Implementation Order

1. Fix `extractMentions()` in `mention-router.ts` — this unblocks @mention for real bot names
2. Add `HUB_POLLING=true` to `.env` — turns on existing scheduler
3. Update `poll-scheduler.ts` — last-seen tracking, skip own messages, no-action handling
4. Rebuild and test

Fix 1 is the most critical — without it, @mentions only work for single-word bot names.
