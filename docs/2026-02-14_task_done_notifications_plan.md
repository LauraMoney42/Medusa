# Task Completion Notifications + Bot Status Icons — Plan
**Project: Medusa** (`~/Medusa`)
**Date:** 2026-02-14
**Author:** PM Bot
**Assign to:** @Full Stack Dev (server detection) + @ui-dev (status icons + badge UI)
**Priority:** Medium — quality of life, reduces "is anyone done?" guessing

---

## Problem

1. When a bot finishes a task, there's no signal. You assign work, then sit wondering if it landed.
2. The sidebar status dots (green idle / yellow busy) don't tell you enough. You can't tell if a bot has pending work, is actively working, or just finished.

---

## Solution: Two Features

### Feature A: `[TASK-DONE:]` Markers + Notification Badge
### Feature B: 4-State Bot Status Icons in Sidebar

---

## Feature B: 4-State Bot Status Icons

### Current State

`SessionList.tsx` lines 158-166 render an 8px colored dot:
- Green (`--success`) = idle
- Yellow (`--warning`) = busy

### New 4-State System

| State | Icon | Color | Meaning | How It's Determined |
|-------|------|-------|---------|---------------------|
| **Idle** | Static dot `●` | Gray (`--text-muted` / `#636366`) | Nothing happening | `status === 'idle'` and no pending hub tasks |
| **Pending task** | Pulsing dot `●` | Green pulse (`--success`) | Has an @mention or assigned task, hasn't started yet | New `hasPendingTask` flag from server |
| **Busy (working)** | Spinning cog `⚙` | Accent green (`--accent`) with CSS spin animation | Actively generating a response | `status === 'busy'` |
| **Task complete** | Checkmark `✓` | Green (`--success`) | Just finished assigned work | `[TASK-DONE:]` received, not yet acknowledged |

### Implementation

**File:** `client/src/components/Sidebar/SessionList.tsx` — MODIFIED

Replace the static `<span style={statusDot}>` with a `<StatusIcon>` component (inline or extracted) that renders based on state:

```typescript
function StatusIcon({ status, hasPendingTask, hasCompletedTask }: {
  status: 'idle' | 'busy';
  hasPendingTask: boolean;
  hasCompletedTask: boolean;
}) {
  // Priority: completed > busy > pending > idle
  if (hasCompletedTask) {
    // Green checkmark
    return <span style={styles.checkmark}>✓</span>;
  }
  if (status === 'busy') {
    // Spinning cog SVG
    return <span style={styles.spinningCog}>⚙</span>;
  }
  if (hasPendingTask) {
    // Pulsing green dot
    return <span style={styles.pulsingDot} />;
  }
  // Idle gray dot
  return <span style={styles.idleDot} />;
}
```

**CSS animations** (add to `global.css`):

```css
@keyframes cogSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes pendingPulse {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.3); }
}
```

**Styles:**

```typescript
idleDot: {
  width: 8, height: 8, borderRadius: '50%',
  background: 'var(--text-muted)',  // Gray
  flexShrink: 0,
},
pulsingDot: {
  width: 8, height: 8, borderRadius: '50%',
  background: 'var(--success)',  // Green
  animation: 'pendingPulse 2s ease-in-out infinite',
  flexShrink: 0,
},
spinningCog: {
  fontSize: 12, lineHeight: '8px',
  color: 'var(--accent)',
  animation: 'cogSpin 2s linear infinite',
  display: 'inline-block',
  flexShrink: 0,
},
checkmark: {
  fontSize: 11, fontWeight: 700, lineHeight: '8px',
  color: 'var(--success)',
  flexShrink: 0,
},
```

### Pending Task Tracking

The server needs to signal when a bot has a pending task (was @mentioned but hasn't responded yet).

**File:** `server/src/hub/mention-router.ts` — MODIFIED

When an @mention is queued (bot is busy) or delivered, emit a socket event:

```typescript
io.emit("session:pending-task", { sessionId: target.id, hasPendingTask: true });
```

When the bot finishes responding to the mention:

```typescript
io.emit("session:pending-task", { sessionId, hasPendingTask: false });
```

**File:** `client/src/stores/sessionStore.ts` — MODIFIED

Add `pendingTasks: Record<string, boolean>` to state, plus `setPendingTask(id, hasPending)` action.

**File:** `client/src/hooks/useSocket.ts` — MODIFIED

Listen for `session:pending-task` → `sessionStore.setPendingTask()`.

---

## Feature A: `[TASK-DONE:]` Markers + Notification Badge

### How It Works

1. **Bots self-report.** When a bot finishes assigned work, it posts:
   ```
   [HUB-POST: Implemented drag-and-drop. [TASK-DONE: Global drag-and-drop image support]]
   ```

2. **Server detects `[TASK-DONE:]` inside hub messages.** Extracts description, stores as completed task, broadcasts `task:done` event.

3. **Client shows a notification badge** in sidebar — green badge with count of completed tasks. Clicking shows a dropdown list, clicking "Clear" acknowledges all.

4. **System prompt instruction** tells bots to use `[TASK-DONE:]` when finishing work.

5. **Status icon changes to checkmark** for the bot that completed the task (see Feature B above).

### Server Changes

**File:** `server/src/hub/store.ts` — MODIFIED

Add `CompletedTask` type:
```typescript
interface CompletedTask {
  id: string;
  hubMessageId: string;
  from: string;
  description: string;
  timestamp: string;
  sessionId: string;
  acknowledged: boolean;
}
```

Add methods to `HubStore`:
- `addCompletedTask(task)` — appends and persists
- `getUnacknowledged()` — returns tasks where `acknowledged === false`
- `acknowledgeAll()` — marks all acknowledged
- Persist to `~/.claude-chat/tasks.json` (separate file, same atomic write pattern)

**File:** `server/src/socket/handler.ts` — MODIFIED

After a hub message is stored, scan for `[TASK-DONE: ...]`:

```typescript
function extractTaskDone(text: string): string | null {
  const match = text.match(/\[TASK-DONE:\s*(.*?)\]/i);
  return match ? match[1].trim() : null;
}
```

When detected:
- Store completed task
- Emit `task:done` to all clients
- Emit `session:pending-task` with `hasPendingTask: false` to clear the pending state

**File:** `server/src/socket/handler.ts` — MODIFIED (`buildHubPromptSection`)

Add to Hub prompt instructions:
```
When you complete an assigned task, report it by including [TASK-DONE: brief description] inside your [HUB-POST: ...] message.
Example: [HUB-POST: Implemented the feature. [TASK-DONE: Global drag-and-drop support]]
```

**File:** `server/src/routes/hub.ts` — MODIFIED

Add endpoints:
```
GET /api/hub/tasks          — returns unacknowledged completed tasks
POST /api/hub/tasks/ack     — marks all as acknowledged, clears checkmarks
```

### Client Changes

**File:** `client/src/types/task.ts` — NEW

```typescript
export interface CompletedTask {
  id: string;
  from: string;
  description: string;
  timestamp: string;
  sessionId: string;
}
```

**File:** `client/src/stores/taskStore.ts` — NEW

Zustand store:
```typescript
interface TaskState {
  completedTasks: CompletedTask[];
}
interface TaskActions {
  addTask: (task: CompletedTask) => void;
  fetchTasks: () => Promise<void>;
  acknowledgeAll: () => Promise<void>;
  getUnacknowledgedCount: () => number;
  hasCompletedTask: (sessionId: string) => boolean;
}
```

`hasCompletedTask(sessionId)` — used by `SessionList` to determine if a bot's icon should show the checkmark.

**File:** `client/src/api.ts` — MODIFIED

```typescript
fetchTasks(): Promise<CompletedTask[]>
acknowledgeTasks(): Promise<void>
```

**File:** `client/src/hooks/useSocket.ts` — MODIFIED

Listen for `task:done` → `taskStore.addTask()`.

**File:** `client/src/components/Sidebar/Sidebar.tsx` — MODIFIED

Add completion notification badge near Hub button:
- Green pill badge with count when `unacknowledgedCount > 0`
- Clicking opens dropdown:
  ```
  ✓ UI Dev — Global drag-and-drop support (2 min ago)
  ✓ Full Stack Dev — Multi-word mention matching (15 min ago)
  [Clear All]
  ```
- Clicking "Clear All" calls `acknowledgeAll()` → clears badge AND resets all checkmark icons back to idle dots

---

## Full Data Flow

```
PM assigns task via Hub: "@ui-dev implement drag-and-drop"
    ↓
Server detects @mention → delivers to UI Dev session
    ↓
Server emits session:pending-task { sessionId, hasPendingTask: true }
    ↓
Sidebar: UI Dev icon changes to PULSING GREEN DOT (pending)
    ↓
UI Dev bot starts responding
    ↓
Server emits session:status { status: "busy" }
    ↓
Sidebar: UI Dev icon changes to SPINNING COG (busy/working)
    ↓
UI Dev finishes, posts: [HUB-POST: Done. [TASK-DONE: Drag-and-drop support]]
    ↓
Server detects [TASK-DONE:], stores task, emits task:done
Server clears pending: session:pending-task { hasPendingTask: false }
    ↓
Sidebar: UI Dev icon changes to GREEN CHECKMARK (complete)
Sidebar: Green notification badge appears: "1"
    ↓
User clicks badge → sees completion list
User clicks "Clear All" → badge gone, checkmarks reset to gray dots
```

---

## Modified Files Summary

| # | File | Type | Owner | Change |
|---|------|------|-------|--------|
| 1 | `client/src/types/task.ts` | NEW | Full Stack | CompletedTask interface |
| 2 | `server/src/hub/store.ts` | MODIFIED | Full Stack | CompletedTask tracking + persistence |
| 3 | `server/src/socket/handler.ts` | MODIFIED | Full Stack | `[TASK-DONE:]` detection + emit + prompt update |
| 4 | `server/src/hub/mention-router.ts` | MODIFIED | Full Stack | Emit `session:pending-task` events |
| 5 | `server/src/routes/hub.ts` | MODIFIED | Full Stack | GET/POST task endpoints |
| 6 | `client/src/stores/taskStore.ts` | NEW | UI Dev | Zustand store |
| 7 | `client/src/stores/sessionStore.ts` | MODIFIED | UI Dev | Add `pendingTasks` state |
| 8 | `client/src/api.ts` | MODIFIED | UI Dev | fetchTasks + acknowledgeTasks |
| 9 | `client/src/hooks/useSocket.ts` | MODIFIED | UI Dev | `task:done` + `session:pending-task` listeners |
| 10 | `client/src/components/Sidebar/SessionList.tsx` | MODIFIED | UI Dev | 4-state StatusIcon + animations |
| 11 | `client/src/components/Sidebar/Sidebar.tsx` | MODIFIED | UI Dev | Completion badge + dropdown |
| 12 | `client/src/styles/global.css` | MODIFIED | UI Dev | `cogSpin` + `pendingPulse` animations |

---

## Implementation Order

### Phase 1: Server (Full Stack Dev)
1. `client/src/types/task.ts` — type definition
2. `server/src/hub/store.ts` — task tracking methods
3. `server/src/socket/handler.ts` — `[TASK-DONE:]` detection + emit + prompt
4. `server/src/hub/mention-router.ts` — `session:pending-task` events
5. `server/src/routes/hub.ts` — task endpoints

### Phase 2: Client (UI Dev)
6. `client/src/stores/taskStore.ts` — Zustand store
7. `client/src/stores/sessionStore.ts` — pendingTasks state
8. `client/src/api.ts` — task API calls
9. `client/src/hooks/useSocket.ts` — listeners
10. `client/src/styles/global.css` — animations
11. `client/src/components/Sidebar/SessionList.tsx` — 4-state StatusIcon
12. `client/src/components/Sidebar/Sidebar.tsx` — badge + dropdown

Phase 1 and Phase 2 can run in parallel — UI Dev can build against the expected socket events and API shape.

---

## Acceptance Criteria

### 4-State Status Icons
- [ ] Idle bot: gray dot
- [ ] Bot with pending @mention task: pulsing green dot
- [ ] Bot actively responding: spinning cog (accent green)
- [ ] Bot that just completed a task: green checkmark
- [ ] State transitions are smooth (no flicker)
- [ ] Cog animation is subtle (2s rotation, not frantic)
- [ ] Pulse animation is gentle (2s ease-in-out)

### Task Completion Notifications
- [ ] Bot posts `[HUB-POST: [TASK-DONE: description]]` → server detects and stores
- [ ] `task:done` socket event broadcasts to all clients
- [ ] Green badge appears in sidebar with unacknowledged count
- [ ] Clicking badge shows completion list (who, what, when)
- [ ] Clicking "Clear All" acknowledges all, resets checkmarks to idle dots
- [ ] Hub message still displays normally (`[TASK-DONE:]` text visible in feed)
- [ ] System prompt instructs bots to use `[TASK-DONE:]`
- [ ] Persists across page refresh

### General
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds

---

## Notes

- `[TASK-DONE:]` is NOT stripped from Hub messages — stays visible as a record.
- The checkmark state is cleared when the user acknowledges via the badge dropdown. After clearing, the bot goes back to idle (gray dot).
- The spinning cog replaces the yellow dot entirely — we no longer use yellow for busy. Cog is more communicative.
- This does NOT create a full task board. Just status signals and completion notifications.
