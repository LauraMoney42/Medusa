# Projects Pane UX Improvements — Plan

**Project:** Medusa
**Date:** 2026-02-15
**Author:** PM2
**Priority:** P1 — user-requested, high visibility

---

## 1. Problem Statement

The Projects pane lists projects in creation order with no visual priority or status indicators. Users can't quickly scan for high-priority work or distinguish completed projects from active ones. This makes it hard to understand what's urgent at a glance.

## 2. User Story

**As a** user managing multiple projects,
**I want** visual priority badges and color-coded status indicators in the Projects sidebar,
**So that** I can instantly see what's urgent, what's in progress, and what's done without reading each project.

## 3. Proposed Solution

Add priority badges (P0/P1/P2) to the left of each project title, color-code project status with visual indicators (green = done, yellow = in progress, red = pending/blocked), sort projects by priority, and automatically sink completed projects to the bottom of the list.

## 4. Scope

**In:**
- Priority badges displayed to the LEFT of project titles (e.g., "P0", "P1", "P2")
- Color-coded status indicators:
  - 🟢 **Green** — Complete/Done projects
  - 🟡 **Yellow** — In Progress projects (at least one task in_progress)
  - 🔴 **Red** — Pending/Blocked/Stalled projects (all tasks pending, or explicitly marked blocked)
- Sort projects by priority: P0 first, then P1, then P2, then unlabeled
- Completed projects (status = complete) automatically sink to the bottom of the list
- Projects within the same priority tier sort by updatedAt (most recent first)

**Out:**
- Editing priority directly from the sidebar (click project to edit priority in ProjectPane)
- Custom priority labels beyond P0/P1/P2
- Drag-to-reorder projects manually (auto-sort only)
- Filtering projects by priority or status

## 5. Acceptance Criteria

- [ ] Given a project, when it has a priority field (P0/P1/P2), then a priority badge appears to the left of the title
- [ ] Given a project with status = complete, then it shows a green indicator and appears at the bottom of the list
- [ ] Given a project with at least one task in_progress, then it shows a yellow indicator
- [ ] Given a project with all tasks pending, then it shows a red indicator
- [ ] Given the project list, then it is sorted: P0 projects first, then P1, then P2, then unlabeled
- [ ] Given completed projects, then they appear at the bottom regardless of priority
- [ ] Given projects of the same priority, then they sort by updatedAt (most recent first)
- [ ] Given the badges and indicators, then they use the Medusa warm charcoal theme colors (no neon)
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds

## 6. Task Breakdown + Assignments

| # | Task | Owner | Dependencies | Est. |
|---|------|-------|-------------|------|
| PU1 | Add priority field to Project type (if not exists) | UI Dev | None | S |
| PU2 | Add priority badge component (P0/P1/P2 pill/chip) | UI Dev | None | S |
| PU3 | Add status color indicator logic (green/yellow/red) | UI Dev | None | S |
| PU4 | Update ProjectList.tsx to render badges + indicators | UI Dev | PU2, PU3 | M |
| PU5 | Implement sort logic (priority → status → updatedAt) | UI Dev | None | M |
| PU6 | Wire sorting into ProjectList rendering | UI Dev | PU5 | S |

**Implementation order:**
1. PU1 + PU2 + PU3 (data model + components)
2. PU4 (render badges + indicators)
3. PU5 + PU6 (sorting logic + wiring)

## 7. Success Criteria

- Users can identify high-priority work at a glance (P0 badges stand out)
- Color-coded status makes it obvious what's done, in progress, or stalled
- Completed projects stay visible but don't clutter the top of the list
- No manual effort needed — sorting and indicators are automatic

## 8. Open Questions

- [ ] Where does priority come from? Is it already in the Project model, or do we need to add it? **Check `server/src/projects/store.ts` and `client/src/types/project.ts`.**
- [ ] What color scheme for priority badges? Suggest: P0 = red, P1 = orange, P2 = blue/gray (subtle, not distracting).
- [ ] Should "blocked" be a separate status field, or inferred from task state? Recommend: infer (if all tasks are pending for more than N days, show red).
