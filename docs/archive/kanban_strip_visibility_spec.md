# P1: Bot Jira Cards Not Visible in Chat Window

**Priority:** P1
**Assigned to:** Full Stack Dev
**Status:** Spec — Ready to investigate
**Date:** 2026-02-19
**Sequence:** After onboarding (user directive)

---

## Problem

Users cannot see their bot's assigned project task cards at the top of individual chat windows. The KanbanStrip component exists and is wired into ChatPane.tsx, but it auto-hides when no tasks match — suggesting a name matching failure between assignment `owner` field and the bot's session name.

## What Exists

- `client/src/components/Chat/KanbanStrip.tsx` — renders assigned tasks in a 3-column Kanban (Pending / In Progress / Done)
- `ChatPane.tsx` renders KanbanStrip between the top bar and MessageList
- Matching logic: case-insensitive partial match between `assignment.owner` and the session's `name`
- Auto-hides entirely when no tasks match

## Likely Root Causes

1. **Name mismatch** — assignment `owner` field stored with different casing, spacing, or abbreviation than the actual session name (e.g., "Full Stack Dev" vs "full-stack-dev" vs "FullStackDev")
2. **Projects not loading** — API fetch or store hydration failing silently; no projects in store = no tasks = strip hidden
3. **Strip collapsed by default** — user may not know to expand; collapsed state persists in localStorage
4. **Active project filter** — KanbanStrip may only show tasks from `status: 'active'` projects; if all projects are marked `complete`, no tasks display

## Investigation Steps

1. Add console.log to KanbanStrip to output: `botName`, all `assignment.owner` values, and match results
2. Check `projectStore` in browser devtools — are projects loading? Are assignments present with owner values?
3. Compare a known assignment's `owner` value against the exact session `name` string
4. Check if KanbanStrip has a collapsed/expanded state stored in localStorage
5. Verify project `status` field — ensure active projects are returning `status: 'active'` not `'complete'`

## Fix Requirements

- Assignment `owner` matching must reliably match bot names as they appear in the session sidebar
- KanbanStrip must default to **expanded** (not collapsed) when the bot has at least one assigned task
- If no tasks are assigned, auto-hide behavior is correct — no change needed
- If projects fail to load, show a graceful empty state or retry — do not silently hide

## Acceptance Criteria

- [ ] Given a bot has tasks assigned in an active project with a matching owner name, the KanbanStrip is visible and expanded at the top of that bot's chat window without any user action
- [ ] Given a bot has no assigned tasks, the KanbanStrip is not shown (existing behavior, keep as-is)
- [ ] Given the assignment owner is "Full Stack Dev" and the session name is "Full Stack Dev", the strip displays correctly (exact match)
- [ ] Given minor casing differences (e.g., "full stack dev" vs "Full Stack Dev"), the strip still displays correctly
- [ ] Given projects fail to load from the API, the strip does not silently hide — either shows a retry or graceful empty state
- [ ] Strip defaults to expanded state when tasks exist — user does not need to manually expand it

## Build Notes

- JS/React change — run `npm run build` before tagging @You (standard two-tier rule)
- Tag @You for verification — user is acting as QA
- Test by: assigning a task to a specific bot in Projects, then opening that bot's chat window and confirming the strip appears without any extra steps
