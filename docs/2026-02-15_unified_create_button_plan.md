# Unified Create Button + Project Creation — Plan
**Project: Medusa** (`~/Medusa`)
**Date:** 2026-02-15
**Author:** Product Manager
**Assign to:** @ui-dev
**Priority:** P1 — Projects feature exists but is unusable without creation UI

---

## Problem

1. The Projects feature is fully built (server API, client store, sidebar list, plan viewer) but invisible because there's no way to create projects from the UI — only via API.
2. The sidebar has a `+ Create Bot` button at the bottom. Adding a separate `+ Create Project` button would clutter the sidebar.

---

## Solution

Replace the `+ Create Bot` button with a single `+` button that opens a dropdown menu with two options:

```
  [+]
  ├── New Bot
  └── New Project
```

Clicking "New Bot" shows the existing bot creation form (name, working dir, system prompt).
Clicking "New Project" shows a new project creation form (title, summary, plan content).

---

## User Stories

**As a** user
**I want** a single `+` button that lets me create either a bot or a project
**So that** the sidebar stays clean and I can create projects without using the API

**As a** PM bot
**I want** projects to be creatable via the existing `POST /api/projects` endpoint
**So that** I can auto-create projects when I write plans (future enhancement)

---

## Changes

### Change 1: Replace `NewSessionButton` with `CreateButton`

**File:** `client/src/components/Sidebar/NewSessionButton.tsx` — MODIFIED (or rename to `CreateButton.tsx`)

Replace the current `+ Create Bot` button with a `+` button that toggles a dropdown:

```
[+]  (green accent button, full width, bottom of sidebar)
  ↓ click
┌─────────────────┐
│  🤖 New Bot      │  ← opens existing bot creation form
│  📋 New Project   │  ← opens new project creation form
└─────────────────┘
```

**Dropdown behavior:**
- Opens on click, closes on outside click or selection
- Two options: "New Bot" and "New Project"
- Selecting an option opens the corresponding inline form (same location, replaces the `+` button area)
- Cancel button returns to the `+` button

**Bot creation form:** Unchanged — name, working directory, system prompt, Create/Cancel buttons. Already exists.

**Project creation form:** New inline form:
- Title (required) — text input
- Summary (optional) — text input, short description
- Status — defaults to "active", no UI needed for MVP
- Plan Content (optional) — textarea, markdown content for the plan
- Assignments (optional, future) — skip for now, can be added via API or PATCH later
- Create / Cancel buttons

On submit: calls `POST /api/projects` with `{ title, summary, status: 'active', content, assignments: [] }`.
On success: project appears in sidebar ProjectList, view switches to project.

### Change 2: Wire Project Creation to Store

**File:** `client/src/stores/projectStore.ts` — MODIFIED

Add `createProject(title, summary, content)` action that:
1. POSTs to `/api/projects`
2. Adds the new project to the local store
3. Sets it as the active project
4. Sets `activeView` to `'project'`

**File:** `client/src/api.ts` — verify `createProject` already exists (it does per devlog)

### Change 3: Update Sidebar Layout

**File:** `client/src/components/Sidebar/Sidebar.tsx` — MODIFIED

Replace `<NewSessionButton />` with `<CreateButton />` (or updated component name). No other sidebar changes needed.

---

## Modified Files Summary

| # | File | Change |
|---|------|--------|
| 1 | `client/src/components/Sidebar/NewSessionButton.tsx` | Replace with unified `+` dropdown + add project creation form |
| 2 | `client/src/stores/projectStore.ts` | Add `createProject` action |
| 3 | `client/src/components/Sidebar/Sidebar.tsx` | Update import if component is renamed |

---

## Acceptance Criteria

### Unified `+` Button
- [ ] Single `+` button at the bottom of the sidebar replaces `+ Create Bot`
- [ ] Clicking opens a small dropdown with "New Bot" and "New Project" options
- [ ] Dropdown closes on outside click
- [ ] Selecting an option opens the corresponding inline form
- [ ] Cancel returns to the `+` button state

### Bot Creation (existing, unchanged)
- [ ] "New Bot" opens the existing form (name, working dir, system prompt)
- [ ] Creating a bot works exactly as before
- [ ] New bot appears in session list and becomes active

### Project Creation (new)
- [ ] "New Project" opens a form with: title (required), summary (optional), plan content (optional textarea)
- [ ] Submitting creates project via `POST /api/projects`
- [ ] New project appears in sidebar ProjectList immediately
- [ ] View switches to the new project's ProjectPane
- [ ] Empty title is rejected (validation)
- [ ] Error state shown if API call fails

### General
- [ ] Styling matches existing sidebar aesthetic (warm charcoal, green accents)
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds

---

## Notes

- The server-side `POST /api/projects` endpoint already exists and works. This is purely a client-side change.
- PM bots can still create projects via the API. This UI just gives the human user a manual option.
- Assignments can be added later via PATCH — not needed in the creation form for MVP.
- Future enhancement: PMs auto-create a project when they write a plan file, populating it with tasks and assignments from the plan.
