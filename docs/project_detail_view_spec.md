# Feature: Project Detail View (P1)

**Priority:** P1
**Author:** PM2
**Assigned to:** UI2 (compact view + expand-on-click) | UI Dev (sidebar space ratio — separate task)
**Status:** Spec updated 2026-02-19 — compact-first per user directive. UI2 actively building.
**Date:** 2026-02-19
**QA:** User is acting as QA — tag @You directly, NOT @QA/Testing or @QA2

---

## Problem

The Projects pane currently shows a flat list of project names and statuses. Users who want to know what's actually happening — who is assigned, what's done, what's pending — have to ask Medusa directly. That's friction. The Projects pane should be a self-service dashboard: everything visible at a glance, no questions needed.

## Proposed Solution

Expand each project card in the Projects pane to show rich inline detail: assigned bots, task status breakdown (TODO / IN PROGRESS / DONE), priority, and a clear split between what's shipped and what's pending. Modeled after the table/breakdown format Medusa shows in chat when asked for a project summary.

## Success Criteria

- User can see project priority and status at a glance without asking Medusa
- Compact list is clean and scannable — no visual noise
- One click reveals full detail per project (assigned bots, tasks, progress)
- View updates in real-time when tasks are updated

---

## Scope

**In:**
- Rich detail view per project in the Projects pane, inline (not a modal or separate page)
- Priority badge (P0/P1/P2/P3) prominently displayed
- Assigned bot names listed (from assignment.owner fields)
- Task status breakdown: count of TODO / IN PROGRESS / DONE
- Task list grouped by status: pending tasks, in-progress tasks, completed tasks
- Visual differentiation between shipped (done) and pending work
- Real-time updates when task status changes

**Out:**
- Editing tasks directly from this view (v2)
- Gantt chart or timeline view
- Cross-project rollup view

---

## Visual Design

**Default (collapsed) state — compact row:**
Each project displays as a minimal single row:
```
🔴 P0  Medusa Screenshot Tool  ●  [active]
🟠 P1  Project Detail View      ●  [active]
⚪ P3  Image Icon Fix            ○  [complete]
```
- Priority badge (color-coded pill: P0=red, P1=orange, P2=yellow, P3=gray)
- Project name (truncated if needed)
- Status dot (filled = active, empty = complete)
- NO task lists, NO progress bars, NO assigned bots visible in this state
- Click anywhere on the row to expand

**Expanded (on-click) state — full detail:**
Match the table/breakdown format shown in Medusa's chat summaries. Example target layout per project card:

```
┌─────────────────────────────────────────────────────┐
│ 🔴 P0  |  Medusa Screenshot Tool          [active]  │
├─────────────────────────────────────────────────────┤
│ Assigned: Full Stack 2, UI Dev                      │
│ Progress: ██████████░░  4 done · 1 in progress · 0 todo │
│                                                     │
│ ✅ DONE                                             │
│   · SC1: Restore camera button visibility           │
│   · SC2: File picker fallback for WKWebView         │
│   · SC3: End-to-end pipeline verified               │
│   · SC4: Native ScreenCaptureKit implementation     │
│                                                     │
│ 🔄 IN PROGRESS                                      │
│   · SC5+SC6: Window picker + system-wide region     │
│                                                     │
│ 📋 TODO                                             │
│   (none)                                            │
└─────────────────────────────────────────────────────┘
```

**Style notes:**
- Dark theme matching Medusa's existing `--bg-primary` / `--bg-secondary`
- Priority badge: color-coded (P0 = red, P1 = orange, P2 = yellow, P3 = gray)
- Progress bar: green fill, proportional to done/(done+in_progress+todo)
- DONE items: muted/secondary color with checkmark
- IN PROGRESS items: green accent with spinner or dot
- TODO items: default text color

---

## Technical Implementation

### Data Source
- `GET /api/projects/:id` returns full project data including all assignments with status
- ProjectStore already caches project data — can extend `projectCache` to include full task list
- Real-time: listen to `projects:updated` socket event to refresh detail view

### Component Structure
```
client/src/components/Projects/
  ProjectCard.tsx           — existing list item, EXTEND this
  ProjectDetailView.tsx     — NEW: rich detail panel rendered inside ProjectCard
  TaskStatusBadge.tsx       — NEW: TODO/IN PROGRESS/DONE pill component
  ProgressBar.tsx           — NEW: visual progress bar (or reuse if exists)
```

### Key Logic
- Group `project.assignments` by `status` field: `pending` → TODO, `in_progress` → IN PROGRESS, `done` → DONE
- Progress bar: `doneCount / totalCount * 100`
- Assigned bots: unique `owner` values from all assignments
- Collapsed/expanded state: default to **collapsed** (compact row) for ALL projects. User clicks to expand for full detail.

### Assignment Status Mapping
| assignment.status | Display label | Color |
|---|---|---|
| `pending` | TODO | gray |
| `in_progress` | IN PROGRESS | green |
| `done` | DONE | muted + strikethrough optional |

---

## Acceptance Criteria

- [ ] Given the Projects pane loads, all projects display as compact rows: priority badge + project name + status dot only — no task lists, no progress bars, no assigned bots visible by default
- [ ] Given a user clicks a project row, it expands to show full detail: assigned bots, task breakdown grouped by status, and progress bar
- [ ] Given a user clicks an expanded project row, it collapses back to compact view
- [ ] Given a project with mixed task statuses, TODO/IN PROGRESS/DONE counts are accurate in the expanded view
- [ ] Given a task status changes (via any mechanism), the detail view updates within 5 seconds without a full page reload
- [ ] Given a complete project, it defaults to collapsed (to reduce visual noise) but can be expanded
- [ ] Given an active project, it defaults to expanded
- [ ] Priority badge is color-coded: P0 red, P1 orange, P2 yellow, P3 gray
- [ ] Progress bar accurately reflects done/(done+in_progress+todo) ratio
- [ ] Assigned bot names are listed and accurate
- [ ] View matches Medusa dark theme — no light mode artifacts
- [ ] Renders correctly on Projects pane at standard Medusa window widths

## Build Notes

- JS/React change — run `npm run build` before tagging @You (two-tier rule)
- Tag @You for verification — user is acting as QA
- **Do not start until user gives sprint resume signal**
- Reference: existing `KanbanStrip.tsx` for task status grouping patterns
