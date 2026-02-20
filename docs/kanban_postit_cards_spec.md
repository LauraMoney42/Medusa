# Post-It Kanban Cards — Plan

**Project:** Medusa
**Date:** 2026-02-15
**Author:** PM2
**Assign to:** @UI Dev (client-only, React components)
**Priority:** P1 — direct user request, high visibility feature

---

## 1. Problem Statement

Users can't see at a glance what each dev bot is working on. Task status is buried in devlog entries, Hub posts, and the Projects panel. There's no per-bot visual representation of work in progress.

## 2. User Story

**As a** user managing multiple dev bots,
**I want** a kanban board at the top of each bot's chat pane showing their tasks as post-it cards,
**So that** I can see what each bot is thinking about, doing, and has completed without leaving the chat view.

## 3. Proposed Solution

A collapsible horizontal kanban strip at the top of each dev bot's ChatPane with three columns (Thinking / Doing / Done). Tasks appear as neon-colored post-it note cards with handwriting font. Cards are derived from existing Project assignments filtered by the bot that owns the chat pane. Draggable between columns using @dnd-kit.

## 4. Scope

**In:**
- Horizontal kanban strip at top of ChatPane
- Three columns: Thinking (pending) / Doing (in_progress) / Done (done)
- Post-it card styling: random neon colors, slight rotation, handwriting font (Google Font CDN)
- Collapsible (expand/collapse toggle)
- 4 cards max per column with "+N more" overflow
- Cards derived from Project assignments filtered by bot name
- Draggable between columns via @dnd-kit
- Drag updates Project assignment status via PATCH API
- Clickable cards open task detail (title, description, status, owner)

**Out:**
- New TaskCard server entity (use existing Project assignments)
- Devlog auto-logging on card moves (defer)
- Auto-archive/fade for Done cards (defer)
- User drag → bot notification via socket (defer — nice-to-have for v2)
- Card physics animations (keep CSS-only for MVP)

## 5. Acceptance Criteria

- [ ] Given a bot's chat pane, when expanded, then a kanban strip appears at the top with Thinking / Doing / Done columns
- [ ] Given Project assignments where owner matches the bot name, then those tasks appear as post-it cards in the correct column
- [ ] Given a card, then it has a random neon color (hot pink, lime green, sunshine yellow, electric orange, sky blue)
- [ ] Given a card, then it uses a handwriting Google Font (Caveat or Permanent Marker)
- [ ] Given a card, then it has slight random rotation (-2 to +3 degrees) and subtle drop shadow
- [ ] Given a card, then the cards are translucent (not opaque blocks)
- [ ] Given more than 4 cards in a column, then excess cards collapse with "+N more" indicator
- [ ] Given the kanban strip, when user clicks collapse toggle, then it minimizes to a slim summary bar
- [ ] Given a card, when user drags it to another column, then the Project assignment status updates via PATCH API
- [ ] Given a card, when user clicks it, then a detail view shows task title, owner, status, and project context
- [ ] Given the kanban strip, then it does not interfere with chat scrolling or message display
- [ ] Given no assignments for a bot, then the kanban strip shows an empty state or auto-collapses
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds

## 6. Task Breakdown + Assignments

| # | Task | Owner | Dependencies | Est. |
|---|------|-------|-------------|------|
| K1 | Install @dnd-kit, add Google Font CDN link | UI Dev | None | S |
| K2 | KanbanStrip component — 3-column layout, collapse toggle | UI Dev | K1 | M |
| K3 | PostItCard component — neon colors, rotation, handwriting font, shadow | UI Dev | K1 | M |
| K4 | Data derivation — filter Project assignments by bot name, map status to columns | UI Dev | None | S |
| K5 | Drag-and-drop between columns — @dnd-kit wiring, PATCH on drop | UI Dev | K2, K3 | M |
| K6 | Card detail view — click to expand task info | UI Dev | K3 | S |
| K7 | Wire into ChatPane — render KanbanStrip at top, pass bot name | UI Dev | K2, K4 | S |
| K8 | Overflow handling — 4-card max, "+N more" indicator | UI Dev | K2, K3 | S |

**Implementation order:**
1. K1 (dependencies) + K4 (data layer) in parallel
2. K3 (PostItCard) + K2 (KanbanStrip layout)
3. K7 (wire into ChatPane)
4. K5 (drag-and-drop)
5. K6 (card detail) + K8 (overflow)

## 7. Success Criteria

- Users can see each bot's workload at a glance without checking Projects or devlog
- Dragging cards between columns feels natural and updates persist
- The post-it aesthetic is visually delightful — users smile when they see it
- The strip doesn't get in the way of normal chat usage

## 8. Open Questions

- [ ] Should the kanban strip be visible by default or start collapsed? Recommend: visible by default, user can collapse.
- [ ] Should we show cards from ALL projects or only active projects? Recommend: active projects only.
- [ ] What happens when a bot has no assignments? Recommend: show empty kanban with a subtle "No tasks assigned" message, or auto-collapse.
