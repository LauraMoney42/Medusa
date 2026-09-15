# Dev Controls

Medusa exposes per-dev pause, interrupt, and status controls so the PM or user can manage bot sessions without restarting the server.

## Backend

- Store: `server/src/dev-control/store.ts`
- Controller: `server/src/dev-control/controller.ts`
- Routes: `server/src/routes/dev-control.ts`
- Mounted at: `POST /api/dev-control/:id/pause`, `POST /api/dev-control/:id/resume`, `POST /api/dev-control/:id/status`

State is persisted to `dev-control.json` and broadcast via Socket.IO (`dev-control:update`).

## Client UI

### Sidebar context menu
Right-click any bot in the left sidebar to:
- **Pause** — aborts any active process and skips the bot in hub polling.
- **Resume** — clears pause/interrupt and restores normal polling.
- **Request status** — interrupts the bot and asks it to post a status update to the Hub.

### Hub slash commands
Type in the Hub input:
- `/pause @Dev1`
- `/resume @Dev1`
- `/status @Dev1`

The `@` is optional. The command executes immediately and is not posted as a Hub message.

## How status requests work

1. The controller sets `statusRequested = true`.
2. If the session is busy, the active process is aborted and `interrupted = true`.
3. If paused, delivery is deferred until the session is resumed.
4. Otherwise, `autonomousDeliver` sends the bot a `[Status Request]` prompt asking it to summarize its current work and post to the Hub.
5. The request flag is cleared after delivery.
