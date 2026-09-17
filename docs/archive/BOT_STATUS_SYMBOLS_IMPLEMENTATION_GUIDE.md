# Bot Status Symbols Implementation Guide

**For:** Sister applications implementing the Medusa-CodePuppy bot coordination system  
**Date:** 2026-02-27  
**Version:** 1.0

---

## Table of Contents

1. [Overview](#1-overview)
2. [The 5-State Status System](#2-the-5-state-status-system)
3. [Status Priority Logic](#3-status-priority-logic)
4. [Frontend Implementation](#4-frontend-implementation)
5. [Backend Socket Events](#5-backend-socket-events)
6. [State Management](#6-state-management)
7. [CSS Animations](#7-css-animations)
8. [Complete Code Examples](#8-complete-code-examples)
9. [Testing Checklist](#9-testing-checklist)

---

## 1. Overview

### What Are Bot Status Symbols?

Bot status symbols are visual indicators displayed next to each bot's name in the sidebar. They provide real-time feedback about what each bot is doing:

- **Active/Busy** → Spinning gear (⚙️)
- **Task Complete** → Green checkmark (✓)
- **Pending Task** → Pulsing green dot (🟢)
- **Idle** → Gray dot (⚫)

These symbols help users understand at a glance:
- Which bots are currently working
- Which bots have completed their tasks
- Which bots are waiting to start assigned work
- Which bots are idle

### Why This Matters

**User Experience:**
- Users can monitor progress without opening each bot's chat
- Clear visual feedback prevents duplicate task assignments
- Status changes provide ambient awareness of system activity

**System Efficiency:**
- Users know when it's safe to interact vs. when to wait
- Prevents interrupting bots mid-task
- Helps identify stuck or idle bots quickly

---

## 2. The 5-State Status System

### State Hierarchy (Highest to Lowest Priority)

The status icon displays according to this priority:

1. **Active Task OR Busy** → ⚙️ Spinning Gear
2. **Task Completed** → ✓ Checkmark
3. **Pending Task** → 🟢 Pulsing Dot
4. **Idle** → ⚫ Gray Dot

### State Definitions

#### 1. Active Task (Highest Priority)

**When Shown:**
- Bot has an `in_progress` task in `projects.json`
- Indicates bot is actively working on an assigned task from the project management system

**Visual:** ⚙️ **Spinning gear** (same as busy state)

**Color:** `var(--accent)` (typically green/teal)

**Use Case:**
```typescript
// Bot has been assigned a task in projects.json
{
  "sessionId": "dev1-uuid",
  "task": "Implement user authentication",
  "status": "in_progress"  // ← Triggers active task state
}
```

**Server Event:**
```typescript
io.emit("dev:task-active", { sessionId: "dev1-uuid", name: "Dev1" });
```

**Frontend State:**
```typescript
activeTasks: Record<string, boolean>  // { "dev1-uuid": true }
```

---

#### 2. Busy (Tied with Active Task)

**When Shown:**
- Bot's Claude CLI process is currently running
- Actively generating a response or executing tools
- Cannot accept new prompts until complete

**Visual:** ⚙️ **Spinning gear** (identical to active task)

**Color:** `var(--accent)`

**Use Case:**
```typescript
// Bot is processing a user message
const response = await autonomousDeliver({
  sessionId,
  prompt: "Review this code",
  source: "user"
});
// During this time: status = "busy"
```

**Server Events:**
```typescript
// BEFORE starting Claude CLI:
io.emit("session:status", { sessionId, status: "busy" });

// AFTER Claude CLI completes:
io.emit("session:status", { sessionId, status: "idle" });
```

**Frontend State:**
```typescript
statuses: Record<string, 'idle' | 'busy'>  // { "dev1-uuid": "busy" }
```

---

#### 3. Task Completed

**When Shown:**
- Bot has posted `[TASK-DONE: description]` to the Hub within the current session
- Indicates successful completion of assigned work
- Persists until session ends or new task assigned

**Visual:** ✓ **Green checkmark**

**Color:** `var(--success)` (typically `#4aba6a`)

**Use Case:**
```typescript
// Bot posts to Hub:
"[HUB-POST: Login endpoint complete. [TASK-DONE: Implemented POST /auth/login with JWT]]"

// Server detects [TASK-DONE:] marker, emits event:
io.emit("task:done", {
  id: "task-uuid",
  sessionId: "dev1-uuid",
  description: "Implemented POST /auth/login with JWT",
  timestamp: "2026-02-27T14:30:00Z"
});
```

**Server Event:**
```typescript
io.emit("task:done", {
  id: string,
  sessionId: string,
  description: string,
  from: string,
  hubMessageId: string,
  timestamp: string
});
```

**Frontend State:**
```typescript
completedTasks: Array<{
  id: string;
  sessionId: string;
  description: string;
  timestamp: string;
}>;

// Check function:
function hasCompletedTask(completedTasks, sessionId) {
  return completedTasks.some(t => t.sessionId === sessionId);
}
```

---

#### 4. Pending Task

**When Shown:**
- Bot has been assigned a task but hasn't started it yet
- Tracked via `session:pending-task` events
- Cleared when bot starts work or completes the task

**Visual:** 🟢 **Pulsing green dot**

**Color:** `var(--success)`

**Animation:** Fades and scales (0.4 opacity → 1.0, scale 1.0 → 1.3)

**Use Case:**
```typescript
// User assigns task via Hub:
"@Dev1 implement the user profile API endpoint"

// Server routes mention, emits pending task:
io.emit("session:pending-task", { 
  sessionId: "dev1-uuid", 
  hasPendingTask: true 
});
```

**Server Events:**
```typescript
// When task assigned (via @mention or projects.json):
io.emit("session:pending-task", { 
  sessionId: string, 
  hasPendingTask: true 
});

// When task started or completed:
io.emit("session:pending-task", { 
  sessionId: string, 
  hasPendingTask: false 
});
```

**Frontend State:**
```typescript
pendingTasks: Record<string, boolean>  // { "dev1-uuid": true }
```

---

#### 5. Idle (Default State)

**When Shown:**
- Bot is not busy, has no active/pending tasks, and hasn't completed any tasks
- Default state when bot is created
- Waiting for user interaction or Hub activity

**Visual:** ⚫ **Small gray dot**

**Color:** `var(--text-muted)` (typically `rgba(255, 255, 255, 0.45)`)

**Use Case:**
- Newly created bot session
- Bot completed a task and cleared pending state
- Bot is in hibernation mode (no assigned work)

**No Server Event Required** — This is the fallback when no other states apply.

---

## 3. Status Priority Logic

### Decision Tree

The status icon is determined by this exact logic:

```typescript
function StatusIcon({ 
  status,           // 'idle' | 'busy' from socket events
  hasPendingTask,   // boolean from session:pending-task events
  hasCompleted,     // boolean from task:done events
  hasActiveTask     // boolean from dev:task-active events
}) {
  // Priority 1: Active task OR busy
  if (hasActiveTask || status === 'busy') {
    return <SpinningGear />;  // ⚙️
  }
  
  // Priority 2: Task completed
  if (hasCompleted) {
    return <Checkmark />;  // ✓
  }
  
  // Priority 3: Pending task
  if (hasPendingTask) {
    return <PulsingDot />;  // 🟢
  }
  
  // Priority 4: Idle (default)
  return <GrayDot />;  // ⚫
}
```

### Why This Order?

**Active/Busy First:**
- Most important state — user needs to know bot is working
- Prevents sending new prompts while bot is mid-task
- Overrides all other states

**Completed Second:**
- Positive feedback — user sees when work is done
- Persists after busy state clears
- Overrides pending/idle states

**Pending Third:**
- Indicates work is queued
- Shows bot will start automatically
- Differentiates from idle (no work assigned)

**Idle Last:**
- Default/fallback state
- Only shown when nothing else applies

---

## 4. Frontend Implementation

### React Component (TypeScript + Inline Styles)

```typescript
import type React from 'react';

/** 5-state status icon component */
function StatusIcon({ 
  status, 
  hasPendingTask, 
  hasCompleted, 
  hasActiveTask 
}: {
  status: 'idle' | 'busy';
  hasPendingTask: boolean;
  hasCompleted: boolean;
  hasActiveTask: boolean;
}) {
  // Priority 1: Active task OR busy → spinning gear
  if (hasActiveTask || status === 'busy') {
    return (
      <span 
        style={statusStyles.spinningCog} 
        title={hasActiveTask ? "Working on assigned task" : "Processing"}
      >
        <svg 
          width="12" 
          height="12" 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2" 
          strokeLinecap="round" 
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </span>
    );
  }
  
  // Priority 2: Task completed → checkmark
  if (hasCompleted) {
    return <span style={statusStyles.checkmark}>✓</span>;
  }
  
  // Priority 3: Pending task → pulsing green dot
  if (hasPendingTask) {
    return <span style={statusStyles.pulsingDot} title="Pending task" />;
  }
  
  // Priority 4: Idle → gray dot
  return <span style={statusStyles.idleDot} title="Idle" />;
}

// Inline styles for each status state
const statusStyles: Record<string, React.CSSProperties> = {
  // Idle state: small gray circle
  idleDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--text-muted)',  // rgba(255, 255, 255, 0.45)
    flexShrink: 0,
  },
  
  // Pending task: pulsing green circle
  pulsingDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--success)',  // #4aba6a
    animation: 'pendingPulse 2s ease-in-out infinite',
    flexShrink: 0,
  },
  
  // Active/busy: spinning gear icon
  spinningCog: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 14,
    height: 14,
    color: 'var(--accent)',  // #4aba6a or app accent color
    animation: 'cogSpin 2s linear infinite',
    flexShrink: 0,
  } as React.CSSProperties,
  
  // Completed: green checkmark
  checkmark: {
    fontSize: 12,
    fontWeight: 700,
    lineHeight: '8px',
    color: 'var(--success)',  // #4aba6a
    flexShrink: 0,
  },
};

export default StatusIcon;
```

### Usage in Session List

```typescript
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore, hasCompletedTask } from '../stores/taskStore';
import StatusIcon from './StatusIcon';

export default function SessionList() {
  const sessions = useSessionStore(s => s.sessions);
  const statuses = useSessionStore(s => s.statuses);        // { sessionId: 'idle' | 'busy' }
  const pendingTasks = useSessionStore(s => s.pendingTasks); // { sessionId: boolean }
  const activeTasks = useSessionStore(s => s.activeTasks);   // { sessionId: boolean }
  const completedTasks = useTaskStore(s => s.completedTasks); // Array<TaskCompletion>

  return (
    <div>
      {sessions.map(session => (
        <div key={session.id} className="session-item">
          <StatusIcon
            status={statuses[session.id] ?? 'idle'}
            hasPendingTask={!!pendingTasks[session.id]}
            hasActiveTask={!!activeTasks[session.id]}
            hasCompleted={hasCompletedTask(completedTasks, session.id)}
          />
          <span>{session.name}</span>
        </div>
      ))}
    </div>
  );
}
```

---

## 5. Backend Socket Events

### Event Types

#### 1. `session:status` - Busy/Idle State

**When to Emit:**
- BEFORE calling Claude CLI (set to `"busy"`)
- AFTER Claude CLI completes (set to `"idle"`)

**Payload:**
```typescript
interface SessionStatusEvent {
  sessionId: string;
  status: 'idle' | 'busy';
}
```

**Example (Server):**
```typescript
import type { Server as SocketIOServer } from 'socket.io';

// Before starting Claude CLI process
async function autonomousDeliver(
  sessionId: string,
  prompt: string,
  io: SocketIOServer
) {
  // Emit busy state
  io.emit("session:status", { sessionId, status: "busy" });
  
  try {
    // Call Claude CLI, stream response...
    const response = await executeClaudeCLI(sessionId, prompt);
    
    // Process response...
    
  } finally {
    // ALWAYS emit idle when done (even on error)
    io.emit("session:status", { sessionId, status: "idle" });
  }
}
```

**Critical Rules:**
- ALWAYS emit `idle` in a `finally` block
- Never leave a session stuck in `busy` state
- Emit `busy` immediately before starting work

---

#### 2. `session:pending-task` - Pending Task State

**When to Emit:**
- User assigns task via `@BotName` mention in Hub
- Bot assigned task in `projects.json`
- Bot completes task (emit with `hasPendingTask: false`)
- Bot posts `[TASK-DONE: ...]` to Hub

**Payload:**
```typescript
interface PendingTaskEvent {
  sessionId: string;
  hasPendingTask: boolean;
}
```

**Example (Server):**
```typescript
// When assigning a task via @mention
function processMention(sessionId: string, message: string) {
  // Emit pending task = true
  io.emit("session:pending-task", { 
    sessionId, 
    hasPendingTask: true 
  });
  
  // Deliver the prompt to the bot...
  autonomousDeliver({ sessionId, prompt: message });
}

// When bot completes task (detected via [TASK-DONE:])
function handleTaskDone(sessionId: string) {
  // Add to completed tasks store...
  io.emit("task:done", { sessionId, ... });
  
  // Clear pending state
  io.emit("session:pending-task", { 
    sessionId, 
    hasPendingTask: false 
  });
}
```

---

#### 3. `dev:task-active` / `dev:task-inactive` - Active Task State

**When to Emit:**
- Bot starts working on a project task (status changes to `in_progress`)
- Bot completes or abandons the task

**Payload:**
```typescript
interface DevTaskActiveEvent {
  sessionId: string;
  name: string;  // Bot name for logging
}
```

**Example (Server):**
```typescript
// When bot picks up a task from projects.json
function assignTaskToBot(sessionId: string, task: Task) {
  task.status = "in_progress";
  
  io.emit("dev:task-active", { 
    sessionId, 
    name: getSessionName(sessionId) 
  });
}

// When task is completed or moved to "done"
function completeTask(sessionId: string) {
  task.status = "done";
  
  io.emit("dev:task-inactive", { 
    sessionId, 
    name: getSessionName(sessionId) 
  });
}
```

---

#### 4. `task:done` - Task Completion Event

**When to Emit:**
- Bot posts `[TASK-DONE: description]` in Hub message
- Detected by Hub post processor

**Payload:**
```typescript
interface TaskDoneEvent {
  id: string;           // Unique task completion ID
  sessionId: string;    // Which bot completed it
  description: string;  // What was completed
  from: string;         // Bot name
  hubMessageId: string; // Hub message containing [TASK-DONE:]
  timestamp: string;    // ISO 8601 timestamp
}
```

**Example (Server):**
```typescript
// Hub post processor detects [TASK-DONE:]
function processHubPost(hubMessage: HubMessage) {
  const taskDesc = extractTaskDone(hubMessage.text);
  
  if (taskDesc) {
    const task = {
      id: uuidv4(),
      sessionId: hubMessage.sessionId,
      description: taskDesc,
      from: hubMessage.from,
      hubMessageId: hubMessage.id,
      timestamp: new Date().toISOString()
    };
    
    // Emit to all clients
    io.emit("task:done", task);
    
    // Clear pending task state
    io.emit("session:pending-task", { 
      sessionId: task.sessionId, 
      hasPendingTask: false 
    });
  }
}

// Extract [TASK-DONE: description] using regex
function extractTaskDone(text: string): string | null {
  const match = text.match(/\[TASK-DONE:\s*(.*?)\]/i);
  return match ? match[1].trim() : null;
}
```

---

## 6. State Management

### Frontend State Stores (Zustand Example)

#### Session Store

```typescript
import { create } from 'zustand';
import type { Socket } from 'socket.io-client';

interface SessionStore {
  // Bot status: idle or busy (from session:status events)
  statuses: Record<string, 'idle' | 'busy'>;
  
  // Pending tasks: true when task assigned, false when cleared
  pendingTasks: Record<string, boolean>;
  
  // Active tasks: true when bot working on in_progress task from projects.json
  activeTasks: Record<string, boolean>;
  
  // Update functions
  setSessionStatus: (sessionId: string, status: 'idle' | 'busy') => void;
  setPendingTask: (sessionId: string, hasPending: boolean) => void;
  setActiveTask: (sessionId: string, hasActive: boolean) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  statuses: {},
  pendingTasks: {},
  activeTasks: {},
  
  setSessionStatus: (sessionId, status) =>
    set((state) => ({
      statuses: { ...state.statuses, [sessionId]: status }
    })),
  
  setPendingTask: (sessionId, hasPending) =>
    set((state) => ({
      pendingTasks: { ...state.pendingTasks, [sessionId]: hasPending }
    })),
  
  setActiveTask: (sessionId, hasActive) =>
    set((state) => ({
      activeTasks: { ...state.activeTasks, [sessionId]: hasActive }
    })),
}));
```

#### Task Store

```typescript
import { create } from 'zustand';

interface TaskCompletion {
  id: string;
  sessionId: string;
  description: string;
  timestamp: string;
}

interface TaskStore {
  completedTasks: TaskCompletion[];
  addCompletedTask: (task: TaskCompletion) => void;
  clearCompletedTasks: () => void;
}

export const useTaskStore = create<TaskStore>((set) => ({
  completedTasks: [],
  
  addCompletedTask: (task) =>
    set((state) => ({
      completedTasks: [...state.completedTasks, task]
    })),
  
  clearCompletedTasks: () => set({ completedTasks: [] }),
}));

// Utility function: check if a session has completed any tasks
export function hasCompletedTask(
  completedTasks: TaskCompletion[], 
  sessionId: string
): boolean {
  return completedTasks.some(t => t.sessionId === sessionId);
}
```

---

### Socket Event Listeners (React Hook)

```typescript
import { useEffect } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';
import type { Socket } from 'socket.io-client';

export function useSocketStatusEvents(socket: Socket | null) {
  const setSessionStatus = useSessionStore(s => s.setSessionStatus);
  const setPendingTask = useSessionStore(s => s.setPendingTask);
  const setActiveTask = useSessionStore(s => s.setActiveTask);
  const addCompletedTask = useTaskStore(s => s.addCompletedTask);
  
  useEffect(() => {
    if (!socket) return;
    
    // Handle busy/idle status changes
    const handleSessionStatus = (data: { sessionId: string; status: 'idle' | 'busy' }) => {
      console.log('[socket] Session status:', data);
      setSessionStatus(data.sessionId, data.status);
    };
    
    // Handle pending task assignments
    const handlePendingTask = (data: { sessionId: string; hasPendingTask: boolean }) => {
      console.log('[socket] Pending task:', data);
      setPendingTask(data.sessionId, data.hasPendingTask);
    };
    
    // Handle active task state (from projects.json)
    const handleTaskActive = (data: { sessionId: string; name: string }) => {
      console.log('[socket] Task active:', data);
      setActiveTask(data.sessionId, true);
    };
    
    const handleTaskInactive = (data: { sessionId: string; name: string }) => {
      console.log('[socket] Task inactive:', data);
      setActiveTask(data.sessionId, false);
    };
    
    // Handle task completions
    const handleTaskDone = (task: {
      id: string;
      sessionId: string;
      description: string;
      timestamp: string;
    }) => {
      console.log('[socket] Task done:', task);
      addCompletedTask(task);
    };
    
    // Register listeners
    socket.on('session:status', handleSessionStatus);
    socket.on('session:pending-task', handlePendingTask);
    socket.on('dev:task-active', handleTaskActive);
    socket.on('dev:task-inactive', handleTaskInactive);
    socket.on('task:done', handleTaskDone);
    
    // Cleanup on unmount
    return () => {
      socket.off('session:status', handleSessionStatus);
      socket.off('session:pending-task', handlePendingTask);
      socket.off('dev:task-active', handleTaskActive);
      socket.off('dev:task-inactive', handleTaskInactive);
      socket.off('task:done', handleTaskDone);
    };
  }, [socket, setSessionStatus, setPendingTask, setActiveTask, addCompletedTask]);
}
```

---

## 7. CSS Animations

### Required CSS Keyframes

Add these to your global CSS file:

```css
/* Spinning gear animation for busy/active state */
@keyframes cogSpin {
  from { 
    transform: rotate(0deg); 
  }
  to { 
    transform: rotate(360deg); 
  }
}

/* Pulsing dot animation for pending task state */
@keyframes pendingPulse {
  0%, 100% { 
    opacity: 0.4; 
    transform: scale(1); 
  }
  50% { 
    opacity: 1; 
    transform: scale(1.3); 
  }
}
```

### CSS Variables (Optional but Recommended)

```css
:root {
  /* Status colors */
  --accent: #4aba6a;              /* Spinning gear color (green/teal) */
  --success: #4aba6a;             /* Checkmark and pulsing dot color */
  --text-muted: rgba(255, 255, 255, 0.45);  /* Idle dot color */
  --text-primary: rgba(255, 255, 255, 0.9); /* General text */
}
```

### Alternative: Inline CSS-in-JS

If you prefer not to use global CSS, you can define animations in JavaScript:

```typescript
// Not recommended — increases bundle size and prevents CSS optimization
const animations = `
  @keyframes cogSpin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @keyframes pendingPulse {
    0%, 100% { opacity: 0.4; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.3); }
  }
`;

// Inject into <head> once
if (typeof document !== 'undefined' && !document.getElementById('status-animations')) {
  const style = document.createElement('style');
  style.id = 'status-animations';
  style.textContent = animations;
  document.head.appendChild(style);
}
```

---

## 8. Complete Code Examples

### Full Status Icon Component (Production-Ready)

```typescript
import type React from 'react';

interface StatusIconProps {
  status: 'idle' | 'busy';
  hasPendingTask: boolean;
  hasCompleted: boolean;
  hasActiveTask: boolean;
}

/**
 * 5-state status icon for bot sessions.
 * 
 * States (priority order):
 * 1. Active task OR busy → spinning gear
 * 2. Task completed → checkmark
 * 3. Pending task → pulsing dot
 * 4. Idle → gray dot
 */
export default function StatusIcon({
  status,
  hasPendingTask,
  hasCompleted,
  hasActiveTask,
}: StatusIconProps): JSX.Element {
  // Priority 1: Active task OR busy
  if (hasActiveTask || status === 'busy') {
    return (
      <span
        style={styles.spinningCog}
        title={hasActiveTask ? 'Working on assigned task' : 'Processing'}
        aria-label={hasActiveTask ? 'Active task' : 'Busy'}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </span>
    );
  }

  // Priority 2: Task completed
  if (hasCompleted) {
    return (
      <span
        style={styles.checkmark}
        title="Task completed"
        aria-label="Completed"
      >
        ✓
      </span>
    );
  }

  // Priority 3: Pending task
  if (hasPendingTask) {
    return (
      <span
        style={styles.pulsingDot}
        title="Pending task"
        aria-label="Pending"
      />
    );
  }

  // Priority 4: Idle
  return (
    <span
      style={styles.idleDot}
      title="Idle"
      aria-label="Idle"
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  idleDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--text-muted, rgba(255, 255, 255, 0.45))',
    flexShrink: 0,
  },
  pulsingDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--success, #4aba6a)',
    animation: 'pendingPulse 2s ease-in-out infinite',
    flexShrink: 0,
  },
  spinningCog: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 14,
    height: 14,
    color: 'var(--accent, #4aba6a)',
    animation: 'cogSpin 2s linear infinite',
    flexShrink: 0,
  } as React.CSSProperties,
  checkmark: {
    fontSize: 12,
    fontWeight: 700,
    lineHeight: '8px',
    color: 'var(--success, #4aba6a)',
    flexShrink: 0,
  },
};
```

### Full Session List Item Example

```typescript
import { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore, hasCompletedTask } from '../stores/taskStore';
import StatusIcon from './StatusIcon';

interface SessionItemProps {
  session: {
    id: string;
    name: string;
  };
  isActive: boolean;
  onClick: () => void;
}

export default function SessionItem({ 
  session, 
  isActive, 
  onClick 
}: SessionItemProps) {
  const status = useSessionStore(s => s.statuses[session.id] ?? 'idle');
  const hasPendingTask = useSessionStore(s => !!s.pendingTasks[session.id]);
  const hasActiveTask = useSessionStore(s => !!s.activeTasks[session.id]);
  const completedTasks = useTaskStore(s => s.completedTasks);
  const hasCompleted = hasCompletedTask(completedTasks, session.id);
  
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 14px',
        borderRadius: 6,
        background: isActive ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
        cursor: 'pointer',
        transition: 'background 0.15s',
      }}
    >
      <StatusIcon
        status={status}
        hasPendingTask={hasPendingTask}
        hasActiveTask={hasActiveTask}
        hasCompleted={hasCompleted}
      />
      <span style={{ fontSize: 14, color: '#fff' }}>
        {session.name}
      </span>
    </div>
  );
}
```

---

## 9. Testing Checklist

### Manual Testing Steps

#### Test 1: Idle State (Default)

**Setup:**
1. Create a new bot session
2. Don't assign any tasks or send any messages

**Expected:**
- ⚫ Small gray dot appears next to bot name
- Tooltip says "Idle"

**Verify:**
```typescript
statuses[sessionId] === undefined || statuses[sessionId] === 'idle'
pendingTasks[sessionId] === undefined || pendingTasks[sessionId] === false
activeTasks[sessionId] === undefined || activeTasks[sessionId] === false
hasCompletedTask(completedTasks, sessionId) === false
```

---

#### Test 2: Busy State (Processing)

**Setup:**
1. Send a message to the bot: "Hello"
2. Observe icon DURING response generation

**Expected:**
- ⚙️ Spinning gear appears immediately
- Gear rotates smoothly (2s per rotation)
- Tooltip says "Processing"

**Verify:**
```typescript
statuses[sessionId] === 'busy'
// Icon should show spinning gear regardless of other states
```

**After Response Completes:**
- Icon changes to ⚫ gray dot (idle)
- No errors in console

---

#### Test 3: Pending Task State

**Setup:**
1. Post to Hub: `@Dev1 implement login endpoint`
2. **Do NOT** open Dev1's chat window yet

**Expected:**
- 🟢 Green pulsing dot appears immediately
- Dot fades (opacity 0.4 → 1.0) and scales (1.0 → 1.3) smoothly
- Animation loops every 2 seconds
- Tooltip says "Pending task"

**Verify:**
```typescript
pendingTasks[sessionId] === true
statuses[sessionId] === 'idle'  // Not busy yet
hasCompletedTask(completedTasks, sessionId) === false
```

---

#### Test 4: Active Task State (From Projects)

**Setup:**
1. Create a project with a task assigned to Dev1
2. Set task status to `"in_progress"` in `projects.json`
3. Restart server or trigger task sync

**Expected:**
- ⚙️ Spinning gear appears (same as busy state)
- Tooltip says "Working on assigned task"

**Verify:**
```typescript
activeTasks[sessionId] === true
// Icon should show spinning gear
```

---

#### Test 5: Task Completed State

**Setup:**
1. Assign task to bot: `@Dev1 create a hello world function`
2. Wait for bot to respond with `[HUB-POST: Done. [TASK-DONE: Created hello world function]]`

**Expected:**
- Icon changes from 🟢 (pending) → ⚙️ (busy) → ✓ (completed)
- ✓ Green checkmark persists after busy state clears
- Tooltip says "Task completed"

**Verify:**
```typescript
hasCompletedTask(completedTasks, sessionId) === true
completedTasks.some(t => 
  t.sessionId === sessionId && 
  t.description === "Created hello world function"
) === true
```

---

#### Test 6: State Priority (Busy Overrides Completed)

**Setup:**
1. Bot has completed a task (✓ checkmark showing)
2. Send another message to the bot

**Expected:**
- Icon changes from ✓ → ⚙️ (busy)
- While bot is working, gear spins (busy overrides completed)
- After response, icon returns to ✓ (completed)

**Verify:**
During processing:
```typescript
statuses[sessionId] === 'busy'
hasCompletedTask(completedTasks, sessionId) === true
// Icon shows spinning gear (busy has priority)
```

---

#### Test 7: State Priority (Active Task Overrides Everything Except Busy)

**Setup:**
1. Bot has completed task (✓ showing)
2. Assign new project task (set `status: "in_progress"`)

**Expected:**
- Icon changes from ✓ → ⚙️ (active task)
- Tooltip changes from "Task completed" → "Working on assigned task"

**Verify:**
```typescript
activeTasks[sessionId] === true
hasCompletedTask(completedTasks, sessionId) === true
// Icon shows spinning gear (active task has priority over completed)
```

---

#### Test 8: Reconnection (Status Recovery)

**Setup:**
1. Bot is busy processing a message
2. Refresh browser (simulate reconnect)

**Expected:**
- On reconnect, socket emits current state
- Icon updates to correct state immediately
- No "stuck" busy states

**Server Code Required:**
```typescript
socket.on('connection', (client) => {
  // Send current status for all sessions on connect
  const sessions = sessionStore.loadAll();
  sessions.forEach(session => {
    const currentStatus = processManager.isSessionBusy(session.id) 
      ? 'busy' 
      : 'idle';
    
    client.emit('session:status', { 
      sessionId: session.id, 
      status: currentStatus 
    });
  });
});
```

---

#### Test 9: Multiple Bots Simultaneously

**Setup:**
1. Create 3 bots: Dev1, Dev2, Dev3
2. Assign task to Dev1 (pending)
3. Send message to Dev2 (busy)
4. Dev3 completes a task (completed)

**Expected:**
- Dev1: 🟢 pulsing dot
- Dev2: ⚙️ spinning gear
- Dev3: ✓ checkmark
- All icons update independently
- No cross-contamination of states

---

#### Test 10: Animation Performance

**Setup:**
1. Create 10+ bot sessions
2. Set half to "busy" (spinning gears)
3. Set half to "pending" (pulsing dots)

**Expected:**
- All animations run smoothly (60fps)
- No jank or stuttering
- CPU usage stays reasonable
- Animations are hardware-accelerated (check DevTools > Performance)

**Verify:**
```javascript
// In Chrome DevTools > Performance:
// - Record 3 seconds with animations running
// - Check "Frames" timeline
// - Green bars should be consistently <16.7ms (60fps)
```

---

### Automated Testing (Example with Jest + React Testing Library)

```typescript
import { render, screen } from '@testing-library/react';
import StatusIcon from './StatusIcon';

describe('StatusIcon', () => {
  test('shows idle dot when all flags are false', () => {
    render(
      <StatusIcon 
        status="idle" 
        hasPendingTask={false} 
        hasActiveTask={false} 
        hasCompleted={false} 
      />
    );
    
    const icon = screen.getByLabelText('Idle');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveStyle({ background: 'var(--text-muted)' });
  });
  
  test('shows spinning gear when busy', () => {
    render(
      <StatusIcon 
        status="busy" 
        hasPendingTask={false} 
        hasActiveTask={false} 
        hasCompleted={false} 
      />
    );
    
    const icon = screen.getByLabelText('Busy');
    expect(icon).toBeInTheDocument();
    expect(icon.querySelector('svg')).toBeInTheDocument();
  });
  
  test('busy overrides completed state', () => {
    render(
      <StatusIcon 
        status="busy" 
        hasPendingTask={false} 
        hasActiveTask={false} 
        hasCompleted={true}  // ← Completed, but...
      />
    );
    
    // Should show gear (busy), not checkmark
    const icon = screen.getByLabelText('Busy');
    expect(icon).toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });
  
  test('shows checkmark when task completed', () => {
    render(
      <StatusIcon 
        status="idle" 
        hasPendingTask={false} 
        hasActiveTask={false} 
        hasCompleted={true} 
      />
    );
    
    const icon = screen.getByLabelText('Completed');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveTextContent('✓');
  });
  
  test('shows pulsing dot when pending', () => {
    render(
      <StatusIcon 
        status="idle" 
        hasPendingTask={true} 
        hasActiveTask={false} 
        hasCompleted={false} 
      />
    );
    
    const icon = screen.getByLabelText('Pending');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveStyle({ 
      animation: expect.stringContaining('pendingPulse') 
    });
  });
  
  test('active task overrides completed', () => {
    render(
      <StatusIcon 
        status="idle" 
        hasPendingTask={false} 
        hasActiveTask={true}  // ← Active task
        hasCompleted={true}   // ← Completed
      />
    );
    
    // Should show gear (active task), not checkmark
    const icon = screen.getByLabelText('Active task');
    expect(icon).toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });
});
```

---

## Summary

This guide covers everything needed to implement the Medusa-CodePuppy bot status symbol system:

✅ **5-state status hierarchy** with clear priority logic  
✅ **Complete React component** with TypeScript types  
✅ **Backend socket events** with exact payloads and timing  
✅ **State management** with Zustand examples  
✅ **CSS animations** for smooth visual feedback  
✅ **Production-ready code** with accessibility support  
✅ **Comprehensive testing** checklist and examples

Copy and adapt the code snippets to match your application's architecture. The core logic and event flow remain the same across any JavaScript/TypeScript stack.

---

**Questions or issues?** Refer to the source implementation in:  
- `client/src/components/Sidebar/SessionList.tsx`  
- `client/src/stores/sessionStore.ts`  
- `client/src/hooks/useSocket.ts`  
- `server/src/socket/handler.ts`  
- `server/src/claude/autonomous-deliver.ts`

**Last Updated:** 2026-02-27  
**Medusa-CodePuppy Version:** 1.0
