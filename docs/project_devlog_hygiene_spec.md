# Project/Devlog Hygiene Automation — Plan

**Project:** Medusa
**Date:** 2026-02-15
**Author:** PM2
**Priority:** P1 — TOP PRIORITY per user directive

---

## 1. Problem Statement

Devs post [TASK-DONE:] markers to Hub when they finish work, but Projects don't auto-update. Manual PATCH operations are unreliable — devs forget, leading to stale Kanban boards and inaccurate project status. This creates visibility gaps and coordination overhead for PMs.

## 2. User Story

**As a** PM tracking project status,
**I want** Projects to auto-update when devs post [TASK-DONE:] to Hub,
**So that** Kanban boards and project status reflect reality without manual intervention.

## 3. Proposed Solution

Server listens for `task:done` socket events (already emitted from Token Optimization work), extracts bot name + task description, fuzzy-matches to project assignments, and auto-PATCHes the assignment status to "done". If manual PATCH already happened, it's a no-op. If dev forgot, automation syncs it.

## 4. Scope

**In:**
- Listen for `task:done` socket events on the server
- Extract bot name (from) and task description from the event payload
- Fuzzy match task description to project assignments (owner name + partial description match)
- Auto-PATCH matched assignment status to "done" via ProjectStore
- Log matches and misses for debugging
- Graceful handling of no-match (log warning, don't fail)

**Out:**
- Manual devlog.md updates (devlog stays manual for now)
- Matching across multiple projects (match within active projects only)
- ML-based smart matching (simple string similarity is sufficient)
- Undo/rollback if wrong task gets marked done (edge case, manual fix)

## 5. Acceptance Criteria

- [ ] Given a bot posts [TASK-DONE: description] to Hub, when task:done event fires, then the server receives it
- [ ] Given the task description, when fuzzy-matched to project assignments, then the best match is identified (owner + description similarity > 60%)
- [ ] Given a match is found, when status is not already "done", then the assignment is PATCH'd to "done" via ProjectStore
- [ ] Given a match is found, when status is already "done", then no PATCH occurs (idempotent)
- [ ] Given no match is found, when searching, then a warning is logged but no error is thrown
- [ ] Given multiple potential matches, when scoring, then the highest-scoring match wins
- [ ] Given the auto-PATCH, then the project's updatedAt timestamp updates
- [ ] Given the automation, then manual PATCH still works (automation doesn't conflict)
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds

## 6. Task Breakdown + Assignments

| # | Task | Owner | Dependencies | Est. |
|---|------|-------|-------------|------|
| PH1 | Create `projects/task-sync.ts` — TaskSyncManager class | Full Stack Dev | None | M |
| PH2 | Implement fuzzy matching (string similarity for task description) | Full Stack Dev | PH1 | S |
| PH3 | Wire into `index.ts` — listen for task:done, call TaskSyncManager | Full Stack Dev | PH1 | S |
| PH4 | Add logging for matches/misses | Full Stack Dev | PH1 | S |
| PH5 | Test with real [TASK-DONE:] posts | Full Stack Dev | PH1-PH4 | S |

**Implementation order:**
1. PH1 (TaskSyncManager skeleton)
2. PH2 (fuzzy matching logic)
3. PH3 (wire into index.ts)
4. PH4 (logging)
5. PH5 (test)

## 7. Success Criteria

- Zero manual PATCH operations needed after devs post [TASK-DONE:]
- Kanban boards reflect reality in real-time
- 90%+ match accuracy (fuzzy matching catches most task descriptions)

## 8. Open Questions

- [ ] What's the threshold for fuzzy match confidence? Recommend: 60% string similarity minimum.
- [ ] Should we match only within "active" projects, or all projects? Recommend: active only (status != complete).
- [ ] What string similarity algorithm? Recommend: Levenshtein distance or simple token overlap (owner name exact match + 50% description token overlap).
