# Token Optimization Plan
**Project: Medusa** (`~/Medusa`)
**Date:** 2026-02-15
**Author:** Product Manager
**Priority:** P0 — user approved, above all other backlog items

---

## 1. Problem Statement

The multi-bot setup burns tokens on routine, low-value interactions. Every bot gets the full Hub feed in its system prompt on every message. Poll check-ins generate verbose responses even when there's nothing to do. Bot-to-bot communication includes pleasantries and restated context. This is expensive and unsustainable as we add more bots and features.

---

## 2. User Stories

**As a** user running multiple bots
**I want** each interaction routed to the cheapest model that can handle it
**So that** I'm not paying Opus prices for "[NO-ACTION]" responses

**As a** user
**I want** bots to communicate tersely with each other and only receive relevant Hub messages
**So that** input and output tokens are minimized without losing coordination quality

---

## 3. Proposed Solution — Three Phases

### Phase 1: Quick Wins (prompt + config changes, minimal code)

**T1: Terse Bot-to-Bot Comms** — Update `buildHubPromptSection()` prompt
- Add instruction: "When communicating with other bots (Hub posts, status updates), keep responses under 50 tokens. No pleasantries, no restating what was said, just the signal."
- Owner: @Product Manager (prompt text) + @Full Stack Dev (apply to handler.ts)

**T2: Idle Bot Hibernation** — Update poll-scheduler
- If a bot has no assigned tasks AND no @mentions in recent Hub messages, skip polling it entirely. Only wake on direct @mention.
- The poll-scheduler already has cooldowns — extend it with an "idle skip" based on `session:pending-task` state.
- Owner: @Backend Dev

**T3: Hub Filtering — @mention only for polls** — Update poll-scheduler prompt
- When building the Hub context for a poll check-in, only include messages that @mention the bot or are from the last 5 minutes (recency window). Don't dump the full 20-message feed.
- This reduces input tokens per poll from ~2000 to ~200-500.
- Owner: @Full Stack Dev (modify `buildHubPromptSection` to accept a filter)

**T4: devlog.md Pagination** — Convention + optional tooling
- Bots should only read the last 24-48 hours of devlog entries by default.
- Add a `## --- Archive above this line ---` marker. Entries above the marker are archived context.
- Optional: script to rotate old entries to `devlog_archive.md`.
- Owner: @Product Manager (convention) + @Backend Dev (optional rotation script)

### Phase 2: Model Routing (biggest impact, needs code)

**T5: Add `--model` flag support to ProcessManager**
- Update `spawnClaude()` to accept an optional `model` parameter and pass `--model <model>` to the Claude CLI.
- Add `model` field to session metadata (SessionStore) so each bot can have a default model.
- Owner: @Full Stack Dev

**T6: Tiered Model Routing Logic**
- Create a routing function that determines model based on message context:
  - `haiku` → messages from poll-scheduler (Hub checks), messages matching `[NO-ACTION]`, simple acknowledgments
  - `sonnet` → normal user messages, coding tasks, feature implementation (default)
  - `opus` → messages containing keywords like "architecture", "plan", "review", "design", or when explicitly requested
- This can start as a simple heuristic in `handler.ts` and `poll-scheduler.ts`. No ML needed.
- Poll scheduler should ALWAYS use haiku — that's the biggest single savings.
- Mention router can use sonnet (it's delivering real work).
- Owner: @Full Stack Dev

**T7: Per-Session Model Override**
- Allow session config to specify a preferred model (e.g., PM bots default to sonnet, dev bots default to sonnet, poll checks always haiku).
- UI: add model selector to SessionEditor.
- Owner: @Full Stack Dev (server) + @ui-dev (SessionEditor dropdown)

### Phase 3: Advanced (future, bigger effort)

**T8: Conversation Summarization** — After N messages, compress history
- When a conversation exceeds a threshold (e.g., 50 messages), summarize older messages into a compact context block.
- Needs a summarization call (could use haiku for the summary itself).
- Significantly reduces input tokens for long-running bot sessions.
- Owner: @Full Stack Dev
- Status: **Future — scope separately when Phase 1+2 are done**

**T9: Compact System Prompts**
- Create a "compact mode" version of each bot's instructions (~50% shorter) for routine operations.
- Full instructions loaded only when starting a complex task or first message.
- Requires a mechanism to detect "routine vs complex" — ties into model routing.
- Owner: @Product Manager (draft compact prompts) + @Full Stack Dev (switching logic)
- Status: **Future — scope separately**

---

## 4. Scope

**In (Phase 1 + 2):**
- Terse comms prompt update
- Idle bot hibernation in poll-scheduler
- Hub filtering for poll check-ins (@mention + recency window)
- devlog pagination convention
- `--model` flag support in ProcessManager
- Tiered model routing (haiku for polls, sonnet default, opus for architecture)
- Per-session model override + UI selector

**Out (Phase 3 / Future):**
- Conversation summarization
- Compact system prompts
- ML-based auto-router
- Token usage tracking/dashboard (nice to have, not MVP)
- Client-side token counter

---

## 5. Task Breakdown + Assignments

| # | Task | Owner | Phase | Dependencies | Est. |
|---|------|-------|-------|-------------|------|
| T1 | Terse bot-to-bot comms (prompt update) | PM + @Full Stack Dev | 1 | None | S |
| T2 | Idle bot hibernation (poll-scheduler) | @Backend Dev | 1 | None | S |
| T3 | Hub filtering for polls (@mention + recency) | @Full Stack Dev | 1 | None | M |
| T4 | devlog pagination convention + rotation | PM + @Backend Dev | 1 | None | S |
| T5 | `--model` flag in ProcessManager | @Full Stack Dev | 2 | None | S |
| T6 | Tiered model routing logic | @Full Stack Dev | 2 | T5 | M |
| T7 | Per-session model override + UI | @Full Stack Dev + @ui-dev | 2 | T5 | M |
| T8 | Conversation summarization | @Full Stack Dev | 3 | — | L |
| T9 | Compact system prompts | PM + @Full Stack Dev | 3 | — | M |

Phase 1 tasks (T1-T4) have zero dependencies and can all run in parallel.
Phase 2 tasks (T5-T7) are sequential: T5 → T6, T5 → T7.
Phase 3 (T8-T9) is future work, scope separately.

---

## 6. Acceptance Criteria

### Phase 1
- [ ] Poll-scheduler uses terse prompt instructions (under 50 tokens for bot-to-bot comms)
- [ ] Idle bots (no pending tasks, no recent @mentions) are NOT polled
- [ ] Poll check-ins only include Hub messages relevant to the bot (@mention or last 5 min)
- [ ] devlog.md has an archive marker; bots read only entries below the marker by default
- [ ] No degradation in task pickup, escalation, or coordination quality

### Phase 2
- [ ] `ProcessManager.spawnClaude()` accepts optional `model` parameter
- [ ] `--model` flag passed to Claude CLI when specified
- [ ] Poll-scheduler always uses haiku
- [ ] Mention-router uses sonnet (or session default)
- [ ] User messages use the session's configured model (default: sonnet)
- [ ] Session metadata includes `model` field
- [ ] SessionEditor UI has model selector dropdown (haiku / sonnet / opus)

### General
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds
- [ ] Existing functionality unchanged for sessions without model override

---

## 7. Success Criteria

- Measurably lower token usage per session — target 50%+ reduction from Phase 1 alone
- Poll check-ins cost ~10x less (haiku + filtered context + terse responses)
- No degradation in output quality for coding tasks (still sonnet/opus)
- Idle bots consume zero tokens when not needed
- User can see/set model per session in the UI

---

## 8. Open Questions

- [ ] Does the Claude CLI `--model` flag work with `--resume`? Need to verify — if model is locked per conversation, routing per-message won't work and we'd need per-session defaults only.
- [ ] Should we track token usage per bot? Would help measure success but adds complexity. Recommend: defer, use Claude API dashboard instead.
- [ ] Is 5-minute recency window right for Hub filtering? Too short = bots miss context, too long = no savings.
- [ ] Should PMs also use haiku for Hub checks? PMs do more nuanced coordination — maybe sonnet for PMs, haiku for dev bots on polls.

---

## Notes

- The single biggest win is T6 (poll scheduler using haiku). Every 2-minute poll across N bots currently uses the default model. Switching to haiku for "[NO-ACTION]" responses could cut poll costs by 90%.
- T3 (Hub filtering) is the second biggest win. Currently every bot gets 20 Hub messages in its system prompt on every interaction. Most are irrelevant to that specific bot.
- Phase 1 is all quick wins that can ship in parallel. Phase 2 requires the `--model` flag foundation (T5) first.
- Conversation summarization (T8) is the long-term play but needs careful design. Defer until Phase 1+2 prove the concept.
