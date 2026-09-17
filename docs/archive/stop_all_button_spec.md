# Stop All Button — Plan

**Project:** Medusa
**Date:** 2026-02-15
**Author:** PM2
**Priority:** P1 — user-requested, high usability impact

---

## 1. Problem Statement

User's Ctrl+C isn't reliably triggering graceful shutdown. They need a visible UI button to stop the server cleanly without hunting for terminal shortcuts or force-killing processes.

## 2. User Story

**As a** user who wants to shut down Medusa,
**I want** a "Stop All" button in the UI that triggers graceful shutdown,
**So that** I can cleanly stop the server without relying on keyboard shortcuts.

## 3. Proposed Solution

Add a "Stop All" button in the Medusa UI header that calls a new `POST /api/shutdown` endpoint. The endpoint triggers the same graceful shutdown logic that SIGTERM/SIGINT handlers use. Include a confirmation dialog warning the user if bots are currently working.

## 4. Scope

**In:**
- `POST /api/shutdown` endpoint on the server
- "Stop All" button in the UI (red accent, top-right placement recommended)
- Confirmation dialog: "Stop server? N bot(s) are currently working. They'll have 30s to finish."
- Button triggers graceful shutdown (30s drain period for active bots)
- Toast notification when shutdown is initiated

**Out:**
- Custom drain timeout per shutdown (use the global 30s default)
- "Cancel shutdown" feature (once started, it runs to completion)
- Restart button (this is shutdown only, not restart)

## 5. Acceptance Criteria

### Server
- [ ] Given `POST /api/shutdown` is called, when received, then it triggers `gracefulShutdown()` with signal "API"
- [ ] Given the shutdown is triggered, then the endpoint returns 200 OK immediately (doesn't wait for shutdown to complete)
- [ ] Given the shutdown starts, then the server emits `server:shutting-down` event to all clients
- [ ] Given no bots are busy, then the server exits immediately
- [ ] Given bots are busy, then the server waits up to 30s for them to finish before force-killing

### Client
- [ ] Given the UI, then a "Stop All" button is visible in the top-right corner (or header)
- [ ] Given the button is clicked, when there are active bots, then a confirmation dialog appears: "Stop server? N bot(s) are currently working."
- [ ] Given the dialog is confirmed, when the API call succeeds, then a toast notification shows "Server shutting down..."
- [ ] Given the dialog is canceled, then nothing happens
- [ ] Given the button styling, then it uses red accent color to signal destructive action
- [ ] Given the shutdown is in progress, then the button is disabled with a "Stopping..." label

### General
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds
- [ ] No regression in existing graceful shutdown behavior (SIGTERM/SIGINT still work)

## 6. Task Breakdown + Assignments

| # | Task | Owner | Dependencies | Est. |
|---|------|-------|-------------|------|
| SA1 | Add `POST /api/shutdown` endpoint | Full Stack Dev | None | S |
| SA2 | Wire endpoint to call `gracefulShutdown('API')` | Full Stack Dev | SA1 | S |
| SA3 | Add "Stop All" button to UI header | UI Dev | None | S |
| SA4 | Confirmation dialog component | UI Dev | SA3 | S |
| SA5 | Wire button → API call → toast notification | UI Dev | SA1, SA3, SA4 | S |

**Implementation order:**
1. SA1 + SA2 (server endpoint — can ship independently)
2. SA3 + SA4 (button + dialog)
3. SA5 (wiring)

## 7. Success Criteria

- User can cleanly shut down Medusa from the UI without keyboard shortcuts
- Active bots get a chance to finish before shutdown (30s grace period)
- No accidental shutdowns (confirmation dialog protects against misclicks)

## 8. Open Questions

- [ ] Where exactly should the button go? Recommend: top-right next to settings/user menu. UI Dev decides final placement.
- [ ] Should the button be visible only when logged in, or always? Recommend: only when authenticated (same as rest of the UI).
