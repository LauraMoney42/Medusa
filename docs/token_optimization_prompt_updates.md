# Token Optimization — Prompt Updates (TO6, TO7, TO8)

**Author:** PM2
**Date:** 2026-02-15
**Status:** Ready for implementation

---

## TO6: Terse Bot-to-Bot Communication Rules

Add the following block to `buildHubPromptSection()` in `server/src/socket/handler.ts`, inside the Hub instructions section (after the escalation block, before the "Active bots" line):

```
IMPORTANT — Token Efficiency:
- When posting to the Hub, keep it under 50 tokens. No pleasantries, no restating what was already said.
- Status updates: state only what changed and what's next. Skip context the reader already has.
- Acknowledgments: "Acknowledged" or "Confirmed" is sufficient. Do not restate the assignment.
- [NO-ACTION] responses: respond with exactly "[NO-ACTION]" — no explanation needed.
- Never open with "Great question!", "Absolutely!", "Thanks for the update!" or similar filler.
- Bot-to-bot communication is signal, not conversation. Be terse.
```

**Where to insert:** In `handler.ts` line ~161, before the `Active bots:` line.

---

## TO7: Structured Hub Check Response Template

Update the poll-scheduler prompt in `server/src/hub/poll-scheduler.ts` to include a fixed response template. Replace the current free-form poll prompt with:

```
[Hub Check] There are {N} new message(s) in the Hub since your last check. Review them in the Hub context above. If any are relevant to your role or expertise, respond via [HUB-POST: your response]. If you have assigned tasks you haven't started or completed, start working on them now and post a status update. If you are blocked, escalate with [HUB-POST: @You 🚨🚨🚨 APPROVAL NEEDED: <what you need>]. If nothing needs your attention, respond with exactly: [NO-ACTION]
```

This forces a structured response pattern:
- Relevant → [HUB-POST: terse response]
- Not relevant → [NO-ACTION]
- Blocked → [HUB-POST: @You 🚨🚨🚨 APPROVAL NEEDED: ...]

No free-form "checking in, nothing to report, here's what I've been thinking about..." responses.

---

## TO8: Compact System Prompts

### Principle
Every bot has two prompt modes:
- **Full mode:** Used for the first message in a session, complex tasks, architecture decisions, or when explicitly requested. This is the current system prompt.
- **Compact mode:** Used for Hub checks, status updates, acknowledgments, and routine follow-ups. ~50% shorter.

### How to implement
The server already knows the interaction type:
- `poll-scheduler.ts` → always compact mode
- `mention-router.ts` → compact mode for acknowledgments, full mode for task delivery
- `handler.ts` (user messages) → full mode by default

### Compact mode rules for all bots

Add to the system prompt when in compact mode (poll checks, simple acknowledgments):

```
You are in COMPACT MODE. Follow these rules:
- Respond in under 100 tokens unless the task requires more.
- Skip preamble, context-setting, and sign-offs.
- Do not restate the question or assignment.
- If no action is needed, respond with exactly: [NO-ACTION]
- If action is needed, do it immediately — do not describe what you plan to do first.
```

### Compact prompt strategy per bot role

| Role | Full prompt | Compact prompt |
|------|------------|----------------|
| PM | Full role description + rules + workflow | "You are a PM. Prioritize, assign, track. Be terse. Under 100 tokens for status updates." |
| UI Dev | Full role description + tech stack + patterns | "You are a UI dev. Build what's assigned. Report [TASK-DONE:] when finished. Be terse in Hub posts." |
| Full Stack Dev | Full role description + architecture context | "You are a full stack dev. Build what's assigned. Report [TASK-DONE:] when finished. Be terse in Hub posts." |
| Backend Dev | Full role description + server context | "You are a backend dev. Build what's assigned. Report [TASK-DONE:] when finished. Be terse in Hub posts." |

### Implementation path
1. **Immediate (no code):** Add the compact mode block to the poll-scheduler system prompt. This is where 80% of wasted tokens happen.
2. **Follow-up (small code change):** Add a `compactMode: boolean` parameter to `buildHubPromptSection()` that truncates the Hub feed to last 5 messages instead of 20, and appends the compact mode instructions.
3. **Future:** Store compact prompt variants per session in SessionStore.

---

## Summary of Changes Needed

| Task | File | Change | Owner |
|------|------|--------|-------|
| TO6 | `server/src/socket/handler.ts` | Add terse comms block to `buildHubPromptSection()` | @Full Stack Dev (apply) |
| TO7 | `server/src/hub/poll-scheduler.ts` | Replace poll prompt with structured template | @Full Stack Dev or @Backend Dev (apply) |
| TO8 | `server/src/hub/poll-scheduler.ts` | Add compact mode instructions to poll system prompt | @Full Stack Dev or @Backend Dev (apply) |
| TO8 | `server/src/socket/handler.ts` | Add `compactMode` parameter to `buildHubPromptSection()` (follow-up) | @Full Stack Dev |

All prompt text is drafted above — devs just need to copy-paste into the right locations. Zero ambiguity.
