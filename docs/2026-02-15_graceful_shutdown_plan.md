# Graceful Shutdown Plan
**Project: Medusa** (`~/Medusa`)
**Date:** 2026-02-15
**Author:** Product Manager
**Assign to:** @Full Stack Dev (all changes are server-side)
**Priority:** P1 — prevents lost work when restarting Medusa

---

## 1. Problem Statement

When Medusa restarts, all active bot processes (Claude CLI child processes) are killed immediately via SIGTERM. Any bot mid-response loses that partial output. There is no warning, no drain period, and no mechanism for bots to resume interrupted work after the server comes back up. The user can't tell which bots were mid-task and which were idle.

---

## 2. User Story

**As a** user restarting Medusa to pick up new features
**I want** active bots to finish their current response before the server shuts down
**So that** I don't lose in-progress work every time I restart

**As a** user who just restarted Medusa
**I want** bots that were working on assigned tasks to automatically resume
**So that** I don't have to manually re-assign work that was already in progress

---

## 3. Proposed Solution — Three Changes

### Change 1: SIGTERM/SIGINT Handler with Drain Period

**File:** `server/src/index.ts` — MODIFIED

Add process signal handlers for `SIGTERM` and `SIGINT`:

```typescript
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[medusa] ${signal} received — starting graceful shutdown`);

  // 1. Stop accepting new connections
  server.close();

  // 2. Stop the poll scheduler (no new polls)
  pollScheduler.stop();

  // 3. Check for busy sessions
  const busySessions = sessionStore.loadAll()
    .filter(s => processManager.isSessionBusy(s.id));

  if (busySessions.length === 0) {
    console.log('[medusa] No active sessions — shutting down immediately');
    process.exit(0);
  }

  console.log(`[medusa] Waiting for ${busySessions.length} active session(s) to finish...`);
  busySessions.forEach(s => console.log(`  - ${s.name} (${s.id})`));

  // 4. Notify clients that shutdown is in progress
  io.emit('server:shutting-down', {
    busySessions: busySessions.map(s => ({ id: s.id, name: s.name })),
  });

  // 5. Wait up to GRACEFUL_TIMEOUT_MS for active sessions to finish
  const timeout = config.gracefulTimeoutMs;
  const start = Date.now();

  const waitForDrain = () => new Promise<void>((resolve) => {
    const check = setInterval(() => {
      const stillBusy = busySessions.filter(s => processManager.isSessionBusy(s.id));

      if (stillBusy.length === 0) {
        clearInterval(check);
        console.log('[medusa] All sessions finished — shutting down');
        resolve();
        return;
      }

      if (Date.now() - start > timeout) {
        clearInterval(check);
        console.log(`[medusa] Timeout (${timeout}ms) — force killing ${stillBusy.length} session(s):`);
        stillBusy.forEach(s => {
          console.log(`  - Force killing: ${s.name}`);
          processManager.abort(s.id);
        });
        resolve();
      }
    }, 500); // Check every 500ms
  });

  await waitForDrain();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

### Change 2: Add `getBusySessions()` to ProcessManager

**File:** `server/src/claude/process-manager.ts` — MODIFIED

Add a method to list all currently busy sessions:

```typescript
/** Returns session IDs that have an active Claude process. */
getBusySessions(): string[] {
  const busy: string[] = [];
  for (const [id, entry] of this.sessions) {
    if (entry.process) busy.push(id);
  }
  return busy;
}
```

### Change 3: Client Shutdown Notification

**File:** `client/src/hooks/useSocket.ts` — MODIFIED

Listen for `server:shutting-down` and show a non-intrusive notification:

```typescript
socket.on('server:shutting-down', (data: { busySessions: { id: string; name: string }[] }) => {
  console.log('[socket] Server shutting down, waiting for:', data.busySessions);
  // Could set a store flag to show a "Server restarting..." banner
});
```

**File:** `client/src/stores/sessionStore.ts` — MODIFIED

Add `isServerShuttingDown: boolean` flag + setter. Used by the UI to show a subtle banner.

**File (optional):** `client/src/components/Sidebar/Sidebar.tsx` or `App.tsx`

Show a small banner: "Server restarting... waiting for N bot(s) to finish" when `isServerShuttingDown` is true.

### Change 4: Config Value

**File:** `server/src/config.ts` — MODIFIED

```typescript
gracefulTimeoutMs: parseInt(process.env.GRACEFUL_TIMEOUT_MS || "30000", 10), // 30 sec
```

### Change 5: Update `freePort()` Behavior

**File:** `server/src/index.ts` — MODIFIED

The current `freePort()` function on line 119 kills any process on the port with SIGTERM before startup. This conflicts with graceful shutdown — a restarting instance would kill the old one mid-drain.

Fix: Add a brief delay after SIGTERM to allow the old process to finish draining (it already has its own timeout). Increase the `sleep` from 0.5s to match the graceful timeout, or check if the port is free in a loop.

Simpler approach: The `freePort()` call already exists. The graceful shutdown handler will have already finished and exited before the new instance starts (since the user triggers the restart). No change may be needed — but verify this doesn't race.

---

## 4. Scope

**In:**
- SIGTERM/SIGINT signal handler with configurable drain timeout (default 30s)
- Stop accepting new connections during shutdown
- Wait for active Claude CLI processes to complete naturally
- Force kill after timeout
- Client notification that server is restarting
- `getBusySessions()` helper on ProcessManager
- `GRACEFUL_TIMEOUT_MS` config value

**Out:**
- Auto-resume of interrupted tasks after restart (future enhancement — would require persisting "in-progress" state and re-sending on startup)
- Graceful handling of the macOS app's WKWebView reload (that's a client/app concern)
- Socket.IO reconnection retry logic (already built into Socket.IO client)
- Hub message about shutdown (bots should just finish naturally)

---

## 5. Modified Files Summary (Task Breakdown)

| # | File | Change | Owner |
|---|------|--------|-------|
| 1 | `server/src/index.ts` | SIGTERM/SIGINT handler, drain loop, `server:shutting-down` emit | Full Stack Dev |
| 2 | `server/src/claude/process-manager.ts` | Add `getBusySessions()` method | Full Stack Dev |
| 3 | `server/src/config.ts` | Add `gracefulTimeoutMs` config value | Full Stack Dev |
| 4 | `client/src/hooks/useSocket.ts` | Listen for `server:shutting-down` | Full Stack Dev |
| 5 | `client/src/stores/sessionStore.ts` | Add `isServerShuttingDown` flag | Full Stack Dev |
| 6 | `client/src/App.tsx` or `Sidebar.tsx` | Optional: "Server restarting..." banner | Full Stack Dev |

---

## 6. Acceptance Criteria

### Graceful Drain
- [ ] When Medusa receives SIGTERM, it stops accepting new connections
- [ ] Active bot sessions are given up to 30s (configurable) to finish their current response
- [ ] If all sessions finish before timeout, server exits immediately
- [ ] If sessions are still running after timeout, they are force-killed and server exits
- [ ] Console logs show which sessions are being waited on and when they finish/timeout
- [ ] Poll scheduler is stopped during shutdown (no new polls)

### Client Notification
- [ ] Client receives `server:shutting-down` event with list of busy sessions
- [ ] UI shows a subtle notification that the server is restarting (not a blocking modal)
- [ ] Socket.IO auto-reconnects when the server comes back up

### No Regressions
- [ ] Normal `abort` (user clicking stop) still works during shutdown
- [ ] `freePort()` doesn't race with the graceful drain
- [ ] If no sessions are busy, shutdown is immediate (no unnecessary waiting)
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds

---

## 7. Success Criteria

- Restarting Medusa while bots are mid-response no longer loses their output
- Bots finish their current response naturally before the server exits
- User sees a clear signal that the server is restarting (not a mysterious disconnect)
- Timeout prevents the server from hanging indefinitely if a bot is stuck

---

## 8. Open Questions

- [ ] Should we also post a Hub message ("Server restarting, draining...") so bots see it in their next context? Might be noisy.
- [ ] Is 30s enough timeout? Claude responses can take 60-90s for complex tasks. Consider 60s default.
- [ ] Should auto-resume of interrupted tasks be a follow-up plan? Would need to persist "session X was mid-response to message Y" and re-trigger on startup.
- [ ] Does the macOS Medusa.app wrapper need any changes for the restart flow, or does WKWebView handle reconnection automatically?

---

## Notes

- The `freePort()` function in `index.ts` already handles stale processes on the port. Graceful shutdown should work alongside it — the old process exits cleanly before the new one tries to bind.
- Socket.IO client has built-in reconnection with exponential backoff. The client should auto-reconnect without any code changes.
- This does NOT solve auto-resume of interrupted work — that's a bigger feature. This just prevents data loss during the drain period.
- The poll scheduler's `stop()` method already exists — it clears the interval timer.
