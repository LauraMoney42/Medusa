# Bot Accountability + Auto-Continuation Plan
**Project: Medusa** (`~/Medusa`)
**Date:** 2026-02-15
**Author:** Product Manager
**Assign to:** @Full Stack Dev (all changes are server-side)
**Priority:** P0 — this is a coordination reliability issue affecting all work

---

## 1. Problem Statement

Bots go silent after being assigned work. They say "ready to start" but then don't start, or they finish a task and stop instead of picking up the next one. The user has to manually poke them. This defeats the purpose of autonomous coordination.

Three specific gaps:

1. **No auto-continuation.** When a bot finishes a task, it stops and waits for the user to type something. It should check the Hub for its next assignment and keep going.
2. **No stale task detection.** If a bot is assigned work and goes dark, nobody notices until someone manually checks.
3. **No escalation path.** When a bot genuinely needs human approval, there's no standard way to flag it urgently.

---

## 2. User Story

**As a** user managing multiple bots
**I want** bots to automatically continue working through their assigned tasks and escalate loudly when they need my input
**So that** I don't have to manually poke each bot to keep work moving

**As a** PM bot coordinating dev bots
**I want** stale assignments to be automatically detected and the bot nudged
**So that** I know when a bot has gone dark and can reassign or unblock

---

## 3. Proposed Solution — Three Changes

### Change 1: Update System Prompt — Auto-Continuation Instructions

**File:** `server/src/socket/handler.ts` — `buildHubPromptSection()`

Update the Hub prompt section to include auto-continuation and escalation instructions. Replace the current prompt text with:

```
--- HUB (shared awareness feed) ---
The Hub is a shared message board where all bots can see each other's posts.
To post a new message to the Hub, include [HUB-POST: your message here] anywhere in your response.
To tag another bot for help, include their name with @: [HUB-POST: @BotName your question].
Only use [HUB-POST: ...] when you genuinely need to communicate — examples: flagging uncertainty, asking for help, reporting task completion, handing off work, or coordinating with teammates.
When you complete an assigned task, include [TASK-DONE: brief description] inside your hub post.
Always post to the Hub when you finish assigned work or need input from the team.
If you have assigned tasks, report your progress. If you're stuck or blocked, say so.

IMPORTANT — Auto-continuation:
- When you finish a task, check the Hub for your next assignment. If you have one, start it immediately. Do NOT wait for the user to tell you to begin.
- If you are idle and see assigned work for you in the Hub, pick it up and start working.
- Only stop and wait if you have NO assigned tasks remaining.

IMPORTANT — Escalation:
- If you need human approval, a decision, or are blocked on something only the user can resolve, post to the Hub with this exact format:
  [HUB-POST: @You 🚨🚨🚨 APPROVAL NEEDED: <description of what you need>]
- Do NOT silently wait. Always escalate visibly.

Active bots: ${botNames}
```

### Change 2: Update Poll Scheduler — Progress Check Prompt

**File:** `server/src/hub/poll-scheduler.ts`

Update the poll message to explicitly ask bots about their assigned work, not just new Hub messages. Change the prompt from:

```
[Hub Check] There are ${newMessageCount} new message(s) in the Hub since your last check. Review them...
```

To:

```
[Hub Check] There are ${newMessageCount} new message(s) in the Hub since your last check. Review them in the Hub context above. If any are relevant to your role or expertise, respond via [HUB-POST: your response]. If you have assigned tasks you haven't started or completed, start working on them now and post a status update. If you are blocked, escalate with [HUB-POST: @You 🚨🚨🚨 APPROVAL NEEDED: <what you need>]. If nothing needs your attention, respond with exactly: [NO-ACTION]
```

### Change 3: Stale Assignment Detection

**File:** `server/src/hub/poll-scheduler.ts` — MODIFIED

Add a stale assignment detector that runs on each poll tick. Logic:

1. When `session:pending-task` is emitted with `hasPendingTask: true`, record `{ sessionId, assignedAt: Date.now() }` in a map.
2. When `session:pending-task` is emitted with `hasPendingTask: false` or `[TASK-DONE:]` is detected, remove the entry.
3. On each poll tick, check the map. If any assignment is older than `STALE_TASK_THRESHOLD_MS` (default: 10 minutes), emit a warning:
   - Emit `hub:message` with: `"⚠️ ${botName} was assigned a task ${minutesAgo} minutes ago and hasn't reported progress. Nudging..."`
   - Auto-send a nudge message to that bot's session: `"You were assigned a task via the Hub ${minutesAgo} minutes ago but haven't started or reported progress. Please check your Hub assignments and either start working or report what's blocking you."`
   - Only nudge once per assignment (set a `nudged: true` flag).

**New config values** (`server/src/config.ts`):
```typescript
staleTaskThresholdMs: parseInt(process.env.STALE_TASK_THRESHOLD_MS || "600000", 10), // 10 min
```

---

## Data Flow

```
PM assigns task: "@ui-dev implement drag-and-drop"
    ↓
MentionRouter detects @mention → delivers to UI Dev → emits session:pending-task
    ↓
StaleAssignmentTracker records: { sessionId: "ui-dev-id", assignedAt: now }
    ↓
UI Dev responds → [TASK-DONE:] → tracker removes entry ✅
    OR
10 minutes pass, no response...
    ↓
Poll tick fires → tracker sees stale assignment
    ↓
Auto-nudge sent to UI Dev: "You were assigned a task 10 min ago..."
    ↓
Warning posted to Hub: "⚠️ UI Dev was assigned a task 10 min ago..."
    ↓
UI Dev responds → starts work or escalates
    ↓
If bot needs human input:
[HUB-POST: @You 🚨🚨🚨 APPROVAL NEEDED: Need clarification on X]
```

---

## 4. Scope

**In:**
- System prompt updates (auto-continuation + escalation instructions)
- Poll prompt updates (ask about assigned work, not just new messages)
- Stale assignment tracking (10-min threshold, single nudge, auto-clear)
- `@You` escalation convention with 🚨🚨🚨 APPROVAL NEEDED format

**Out:**
- Full task board / assignment store (structured tracking beyond pending-task flag)
- Graceful shutdown (letting bots finish before server restart) — future enhancement
- Auto-restart of interrupted work after server restart — future enhancement
- Client-side UI for stale warnings (server + Hub only for now)

---

## 5. Modified Files Summary (Task Breakdown)

| # | File | Change |
|---|------|--------|
| 1 | `server/src/socket/handler.ts` | Update `buildHubPromptSection()` prompt text — add auto-continuation + escalation instructions |
| 2 | `server/src/hub/poll-scheduler.ts` | Update poll message prompt + add stale assignment tracking + auto-nudge |
| 3 | `server/src/config.ts` | Add `staleTaskThresholdMs` config value |

---

## 6. Acceptance Criteria

### Auto-Continuation
- [ ] When a bot finishes a task and has another assignment in the Hub, it starts the next task without waiting for user input
- [ ] System prompt includes clear instructions about not stopping when work remains
- [ ] Bots pick up assigned work they see during poll check-ins

### Escalation
- [ ] When a bot needs human approval, it posts `@You 🚨🚨🚨 APPROVAL NEEDED: <description>` to the Hub
- [ ] The escalation message is visible in the Hub feed
- [ ] Bots do NOT silently wait — they always escalate visibly

### Stale Assignment Detection
- [ ] Assignments older than 10 minutes without progress trigger an auto-nudge
- [ ] Auto-nudge sends a message directly to the bot's session
- [ ] Warning appears in Hub feed so PMs and user can see it
- [ ] Each assignment is only nudged once (no spam)
- [ ] Nudge is cleared when bot responds with [TASK-DONE:] or pending-task is set to false

### Poll Prompt Update
- [ ] Poll message explicitly asks bots to check for and start assigned tasks
- [ ] Poll message includes escalation instructions

### General
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds
- [ ] Existing Hub, mention routing, and polling functionality unchanged

---

## 7. Success Criteria

- Bots autonomously pick up their next assigned task after finishing one, without user intervention
- When a bot needs human input, a visible 🚨🚨🚨 APPROVAL NEEDED message appears in the Hub within seconds (not minutes of silence)
- Stale assignments are detected and the bot is nudged within 10 minutes — PMs and the user see the warning in the Hub
- Reduction in "did UI Dev pick that up?" moments — the system handles accountability automatically

---

## 8. Open Questions

- [ ] Should the stale threshold be 10 minutes or shorter? Bots typically respond within 1-2 minutes when active.
- [ ] Should `@You` notifications eventually trigger a desktop notification / sound? (Out of scope for now, but worth noting)
- [ ] If a bot is nudged and still doesn't respond, should there be a second escalation? (Recommend: no, flag it in Hub and let PM handle manually)

---

## Mandatory Devlog Rule (All Bots)

Every bot — dev, PM, QA — MUST append an entry to `~/Medusa/devlog.md` after every task completion or significant change. No exceptions.

**Format:**
```
## YYYY-MM-DD HH:MM — [Bot Name]
**Task:** Brief description
**Status:** completed | in_progress | blocked
**Notes:**
- What was changed and why
- Files affected: list all modified files
```

Rules:
- Always append — never edit or delete previous entries
- Timestamp is mandatory — use current date/time in `YYYY-MM-DD HH:MM` format
- Must be written BEFORE tagging @You or claiming a task done
- If you touched a file, it goes in the log. No exceptions.

---

## Notes

- `@You` is the convention for tagging the human user in the Hub. The system prompt tells bots to use this when they need escalation.
- The 10-minute stale threshold is configurable via `STALE_TASK_THRESHOLD_MS` env var. Can be adjusted based on how fast bots typically respond.
- Auto-continuation relies on the system prompt — it's a "best effort" behavioral nudge, not a hard guarantee. Some bots may still stop. The stale detection is the safety net.
- Change 1 (prompt update) and Change 2 (poll prompt) are quick text changes. Change 3 (stale tracking) is the most involved but still small — it's a Map + a check on the poll tick.
