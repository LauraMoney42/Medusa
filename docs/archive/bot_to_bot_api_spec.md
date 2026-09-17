# Feature Spec: Bot-to-Bot Direct Delivery API

**Priority:** P0
**Author:** Product Manager
**Date:** 2026-02-19
**Status:** Ready for implementation

---

## Problem

Bot-to-bot coordination currently routes through the Hub via `[HUB-POST: @BotName message]`. This path is expensive and wrong for internal traffic:

1. **Token waste** — every bot-to-bot message is written to `hub.json`, broadcast to all clients via `io.emit("hub:message")`, and injected into the Hub context of every bot on their next poll. A 3-deep mention chain (`MAX_CHAIN_DEPTH=3`) multiplies this cost 3x.
2. **Hub pollution** — user-facing Hub feed fills with internal coordination traffic (task handoffs, status pings, acknowledgments) that the user doesn't need to see.
3. **No semantic distinction** — today there is no difference between "PM assigning a task to a bot" (user-visible) and "Backend Dev telling Full Stack Dev the API is ready" (internal). Both go through Hub identically.

The architecture review (`docs/architecture_review_report.md`) identifies mention chain amplification as a primary token cost driver. This spec eliminates it for bot-to-bot traffic.

---

## Proposed Solution

Introduce a new bot output token: `[BOT-TASK: @BotName message]`

The server's post-processor (`post-processor.ts`) already parses `[HUB-POST: ...]` tokens from bot output. We add parallel handling for `[BOT-TASK: ...]` tokens that:
- Route directly to the target bot via `autonomousDeliver()`
- **Skip** `hubStore.add()` — not persisted to `hub.json`
- **Skip** `io.emit("hub:message")` — not broadcast to clients
- **Skip** Hub context injection for all other bots

The Hub remains exclusively for user-visible communication.

---

## Scope

**In (v1 — must ship):**
- Parse `[BOT-TASK: @BotName message]` in `post-processor.ts`
- Resolve `@BotName` to `sessionId` via session store (same lookup as `mentionRouter`)
- Deliver directly via `autonomousDeliver({ source: "bot-to-bot", ... })`
- Respect existing `MAX_CHAIN_DEPTH` guard — bot-to-bot chains count toward the limit
- Respect existing `spawnLock` — if target bot is busy, queue via `pendingMentions`
- No Hub write, no broadcast, no Hub context injection for other bots
- Update bot system prompts: use `[BOT-TASK: ...]` for internal coordination, `[HUB-POST: ...]` for user-visible content only

**Out (v1):**
- REST endpoint (`POST /api/internal/bot-deliver`) — not needed; post-processor approach is sufficient and architecturally consistent
- Bot discovery API — bots use `@BotName` as today; resolution is server-side
- Delivery guarantees / acknowledgments — fire and forget, same as current mention delivery
- Message queuing beyond `pendingMentions` (max 1, existing behavior)
- Any changes to user → bot communication

---

## Technical Design

### New Output Token

```
[BOT-TASK: @TargetBotName your message here]
```

Rules:
- Single line only (consistent with `[HUB-POST: ...]` parsing)
- `@TargetBotName` must match an active session name (case-insensitive, same as mention routing)
- Multiple `[BOT-TASK: ...]` tokens in one response are processed in order
- If `@TargetBotName` cannot be resolved, log a warning and drop silently (no fallback to Hub — fail quietly, don't pollute Hub with unresolvable internal messages)

### Server Changes

**`post-processor.ts`**
- Add `BOT_TASK_REGEX = /\[BOT-TASK:\s*@(\w[\w\s]*?)\s+(.*?)\]/gs`
- In `processHubPosts()`, after extracting `[HUB-POST: ...]` tokens, extract `[BOT-TASK: ...]` tokens
- For each: resolve bot name → sessionId via session store; call `autonomousDeliver({ sessionId, prompt: message, source: "bot-to-bot", chainDepth: currentDepth + 1 })`
- Do NOT call `hubStore.add()` or `io.emit()` for these tokens

**`autonomous-deliver.ts`**
- Add `"bot-to-bot"` to the `source` union type
- `bot-to-bot` source: use compact mode (same as `poll`/`nudge`) — internal task messages don't need full Hub history

**Bot system prompts (all bots)**
- Add to instructions: "Use `[BOT-TASK: @BotName message]` when coordinating with another bot (task handoffs, status updates, asking for information). Use `[HUB-POST: @BotName message]` only when the content is relevant for the user to see."

### Chain Depth

`MAX_CHAIN_DEPTH=3` already exists. Bot-to-bot delivery increments `chainDepth`. If `chainDepth >= MAX_CHAIN_DEPTH`, drop the message and log a warning. No change to the constant needed.

---

## Token Impact

| Scenario | Before | After |
|---|---|---|
| Bot A → Bot B task handoff | ~1,400 tokens (Hub write + 10 bots receive Hub context update) | ~200 tokens (compact deliver to Bot B only) |
| 3-deep mention chain | ~4,200 tokens | ~600 tokens |
| Bot-to-bot acknowledgment ("Got it, starting now") | ~1,400 tokens visible to all | Eliminated — use `[NO-ACTION]` instead |

**Estimated savings: 60–85% reduction on bot-to-bot traffic.** High-chatter sprints (multiple bots coordinating) see the largest gains.

---

## Acceptance Criteria

- [ ] Given a bot outputs `[BOT-TASK: @TargetBot message]`, when processed, then the message is delivered to TargetBot's session directly via `autonomousDeliver()`
- [ ] Given a `[BOT-TASK: ...]` is processed, then no entry is written to `hub.json`
- [ ] Given a `[BOT-TASK: ...]` is processed, then no `hub:message` event is broadcast to clients
- [ ] Given a `[BOT-TASK: ...]` is processed, then the Hub feed shown to the user does not include the message
- [ ] Given `@TargetBotName` cannot be resolved to an active session, then the message is dropped and a warning is logged — no Hub fallback
- [ ] Given a bot-to-bot chain reaches `MAX_CHAIN_DEPTH`, then further `[BOT-TASK: ...]` tokens are dropped and a warning is logged
- [ ] Given the target bot is busy, then the `[BOT-TASK: ...]` is queued via `pendingMentions` (existing behavior)
- [ ] Given a bot uses `[HUB-POST: ...]`, then behavior is unchanged — still written to Hub, broadcast to clients
- [ ] `npm run build` passes with 0 TypeScript errors
- [ ] No degradation in existing Hub @mention or user → bot message delivery

---

## Assignment

| Task | Owner | Notes |
|---|---|---|
| `post-processor.ts` — parse `[BOT-TASK: ...]`, resolve bot name, call `autonomousDeliver()` | Full Stack Dev | Core routing logic |
| `autonomous-deliver.ts` — add `"bot-to-bot"` source, compact mode for bot-to-bot | Full Stack Dev | Minor type + mode change |
| Bot system prompt updates — all active bots | PM / PM2 | Prompt-only change, no code |
| QA verification | User (@You) | User is acting as QA for Medusa |

---

## Open Questions

1. Should `[BOT-TASK: ...]` tokens be logged anywhere server-side for debugging? Recommend: yes, log to console at `debug` level (bot name, target, message excerpt) — not persisted, not user-visible.
2. Should bots be able to send `[BOT-TASK: ...]` to themselves? Recommend: drop with a warning — no valid use case.
3. What happens if a bot accidentally uses `[BOT-TASK: ...]` in user-facing content? The token is stripped from output just like `[HUB-POST: ...]` — it never renders to the user.
