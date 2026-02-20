# Token Optimization — Plan

**Project:** Medusa
**Date:** 2026-02-15
**Author:** PM2
**Priority:** P0 — above all backlog items. Direct user approval.

---

## 1. Problem Statement

Multi-bot setup burns tokens on routine, low-value interactions — Hub checks that return [NO-ACTION], verbose bot-to-bot pleasantries, full conversation transcripts carried forward indefinitely, and every bot receiving every Hub message regardless of relevance. Token costs scale linearly with bot count and session length, making the current architecture unsustainable.

## 2. User Story

**As a** user running multiple bots simultaneously,
**I want** the system to use the cheapest model and least context possible for each interaction,
**So that** I get the same output quality at a fraction of the token cost.

## 3. Proposed Solution

Three workstreams attacking input tokens, output tokens, and model cost separately. Each workstream is independently shippable — we don't need all three to see savings.

## 4. Scope

**In:**

### Workstream 1: Tiered Model Routing (Highest impact)
- Route interactions to the cheapest capable model:
  - **Haiku:** Hub checks, status updates, acknowledgments, [NO-ACTION] responses, simple Q&A
  - **Sonnet:** Coding tasks, code edits, feature implementation, devlog writes
  - **Opus:** Architecture decisions, complex reviews, multi-step planning, ambiguous problems
- Implementation: routing logic in the server that selects model based on interaction type
- Fallback: if a task fails or produces low-quality output on a cheaper model, retry on the next tier up

### Workstream 2: Context Trimming (Reduce input tokens)
- **Hub filtering:** Bots only receive Hub messages that @mention them or are tagged with their role. No more full feed to every bot.
- **Conversation summarization:** After N messages (configurable, e.g. 20), compress older messages into a summary. Carry the summary + recent messages, not the full transcript.
- **devlog.md pagination:** Only inject last 24-48 hours of entries into bot context. Archive older entries to `devlog_archive.md`.
- **Idle bot hibernation:** Bots with no assigned tasks stop polling the Hub entirely. Wake only on @mention.

### Workstream 3: Output Efficiency (Reduce output tokens)
- **Terse bot-to-bot comms:** Update all bot system prompts — Hub posts and status updates must be under 50 tokens. No pleasantries, no restating.
- **Structured status template:** Hub check responses use a fixed format, not free-form prose.
- **Compact system prompts:** Create ~50% shorter versions of bot instructions for routine operations. Full instructions loaded only for complex tasks.

**Out:**
- Token tracking dashboard (nice-to-have, separate project)
- Changing the Claude API provider or pricing model
- Reducing bot count (user decides how many bots to run)
- Any changes to Clippy (separate project, separate repo)

## 5. Acceptance Criteria

### Workstream 1: Tiered Model Routing
- [ ] Given a Hub check interaction, when routed, then it uses Haiku (not Sonnet/Opus)
- [ ] Given a coding task, when routed, then it uses Sonnet
- [ ] Given an architecture decision or complex review, when routed, then it uses Opus
- [ ] Given a model selection, then the routing logic is configurable (not hardcoded)
- [ ] Given a cheaper model produces inadequate output, then there is a retry/escalation path

### Workstream 2: Context Trimming
- [ ] Given a bot with no @mentions in recent Hub messages, then it receives zero Hub context in its prompt
- [ ] Given a conversation with 30+ messages, then older messages are summarized and the full transcript is not sent
- [ ] Given devlog.md has entries older than 48 hours, then only recent entries are injected into bot context
- [ ] Given a bot with no assigned tasks, then it does not poll the Hub until @mentioned

### Workstream 3: Output Efficiency
- [ ] Given a bot posting to the Hub, then the post is under 50 tokens for status updates and acknowledgments
- [ ] Given a Hub check response, then it follows a structured template (not free-form)
- [ ] Given a routine operation, then the bot uses a compact system prompt (~50% shorter)

### General
- [ ] No degradation in output quality for coding tasks
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds

## 6. Task Breakdown + Assignments

| # | Task | Owner | Dependencies | Est. | Workstream |
|---|------|-------|-------------|------|------------|
| TO1 | Model routing logic — classify interaction type, select model | Full Stack Dev | None | L | WS1 |
| TO2 | Hub filtering — only deliver @mentioned/role-tagged messages to each bot | Full Stack Dev | None | M | WS2 |
| TO3 | Idle bot hibernation — stop polling for bots with no tasks, wake on @mention | Backend Dev | None | M | WS2 |
| TO4 | Conversation summarization — compress history after N messages | Full Stack Dev | None | L | WS2 |
| TO5 | devlog.md pagination — inject only last 48h, archive older entries | Backend Dev | None | S | WS2 |
| TO6 | Terse bot-to-bot comms — update all bot system prompts | PM2 | None | S | WS3 |
| TO7 | Structured status template — fixed format for Hub check responses | PM2 | TO6 | S | WS3 |
| TO8 | Compact system prompts — draft 50% shorter versions for routine ops | PM2 | None | M | WS3 |

**Implementation order:**
1. **TO6 + TO7 + TO8** (prompt updates) — zero code changes, immediate impact, PM can do this now
2. **TO2 + TO3 + TO5** (context trimming) — server changes, medium effort, high impact
3. **TO1** (model routing) — biggest impact but most complex, needs careful testing
4. **TO4** (conversation summarization) — largest effort, ship last

## 7. Success Criteria

- Measurably lower token usage per session (target: 50%+ reduction for routine operations)
- No degradation in code quality for implementation tasks
- Hub check-ins that return [NO-ACTION] cost <500 tokens total (input + output)
- Bot-to-bot communication is noticeably terser without losing signal

## 8. Open Questions

- [ ] How do we measure token usage before/after? Need a baseline. Can we log tokens per API call on the server?
- [ ] Should model routing be automatic (server classifies) or manual (PM specifies model per task assignment)?
- [ ] Conversation summarization — what summarization model do we use? Haiku for cheap summaries, or Sonnet for quality?
- [ ] Compact prompts — do we maintain two versions of each bot's instructions, or dynamically trim?
- [ ] Is there a risk that Haiku-tier responses for Hub checks will miss important context? Need to test.
