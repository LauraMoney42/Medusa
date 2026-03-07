# Medusa Project Management System Guide

**Purpose:** Reference document for porting the Medusa project management system to a sister application.
**Date:** 2026-02-28
**Version:** 1.0

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Data Model](#2-data-model)
3. [Server Architecture](#3-server-architecture)
4. [REST API](#4-rest-api)
5. [Real-Time Sync (Socket.IO)](#5-real-time-sync-socketio)
6. [Client Architecture](#6-client-architecture)
7. [Bot Instructions for Project Management](#7-bot-instructions-for-project-management)
8. [Auto Task Sync (TASK-DONE Detection)](#8-auto-task-sync-task-done-detection)
9. [Quick Tasks (Lightweight Alternative)](#9-quick-tasks-lightweight-alternative)
10. [Complete Code Snippets](#10-complete-code-snippets)
11. [Wiring It All Together](#11-wiring-it-all-together)

---

## 1. System Overview

Medusa's project management system is a **lightweight, file-backed PM layer** where:

- Projects and assignments are stored in a JSON file (`projects.json`) on the server
- Bots (PM, devs) read and write projects via REST API or direct file edits
- The UI updates in real-time via Socket.IO when the file changes
- Task completions detected in Hub posts automatically update assignment statuses
- The PM bot (Medusa) is instructed to maintain this file as the source of truth

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        CLIENT (React + Vite)                          │
│                                                                        │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────┐  │
│  │  ProjectPane     │  │  ProjectDetailCard│  │  Sidebar           │  │
│  │  (main view)     │  │  (per-project)   │  │  ProjectList       │  │
│  │                  │  │                  │  │  (compact cards)   │  │
│  └────────┬─────────┘  └──────────────────┘  └────────────────────┘  │
│           │                                                            │
│           ▼                                                            │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │              useProjectStore (Zustand)                           │  │
│  │  projects[], activeProjectId, projectCache{}, fetchProjects()   │  │
│  │  Listens to socket "projects:updated" for real-time refresh     │  │
│  └────────────────────────────┬────────────────────────────────────┘  │
│                               │ REST API + Socket.IO                   │
└───────────────────────────────┼────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        SERVER (Node.js / Express)                     │
│                                                                        │
│  ┌──────────────────┐    ┌──────────────────┐    ┌─────────────────┐  │
│  │  /api/projects   │    │  ProjectStore    │    │  TaskSyncManager│  │
│  │  REST Router     │    │  (file-backed)   │    │  (auto-sync)    │  │
│  │                  │    │                  │    │                 │  │
│  │  GET /           │───►│  projects.json   │    │  Listens for    │  │
│  │  GET /:id        │    │  (atomic writes) │    │  task:done →    │  │
│  │  POST /          │    │                  │    │  fuzzy-matches  │  │
│  │  PATCH /:id      │    │  watchFile()     │    │  → updates      │  │
│  │  DELETE /:id     │    │  detects changes │    │  assignment     │  │
│  └──────────────────┘    └────────┬─────────┘    └─────────────────┘  │
│                                   │                                    │
│                          file change detected                          │
│                                   │                                    │
│                                   ▼                                    │
│                     io.emit("projects:updated", [...])                 │
│                     → all connected clients refresh instantly          │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    projects.json (disk)
```

---

## 2. Data Model

### Project Schema (Zod validated)

```typescript
// server/src/projects/store.ts

const AssignmentSchema = z.object({
  id: z.string().optional(),  // uuid — optional for legacy data, backfilled at load
  owner: z.string(),          // Bot name: "Dev1", "Dev2", etc.
  task: z.string(),           // Task description
  status: z.enum(["pending", "in_progress", "done"]),
});

const ProjectSchema = z.object({
  id: z.string(),             // uuid
  title: z.string(),          // Short display name
  summary: z.string(),        // One-line description
  content: z.string(),        // Full markdown body (plan, specs, etc.)
  status: z.enum(["active", "complete"]),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  assignments: z.array(AssignmentSchema),
  createdAt: z.string(),      // ISO timestamp
  updatedAt: z.string(),      // ISO timestamp — updated on every write
});
```

### Client Types

```typescript
// client/src/types/project.ts

export interface Assignment {
  id?: string;
  owner: string;       // Bot name
  task: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface ProjectSummary {
  id: string;
  title: string;
  summary: string;
  status: 'active' | 'complete';
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  assignments: Assignment[];
  createdAt: string;
  updatedAt: string;
}

// Full project adds markdown body
export interface Project extends ProjectSummary {
  content: string;
}
```

### Example `projects.json` Entry

```json
[
  {
    "id": "abc123-uuid",
    "title": "TicBuddy MVP1",
    "summary": "Kid-friendly Tourette tic tracking + CBIT support app",
    "content": "## Plan\n\n### Week 1\n- Onboarding polish\n- CBIT system prompt\n\n### Week 2\n- Caregivers section full content",
    "status": "active",
    "priority": "P1",
    "assignments": [
      {
        "id": "def456-uuid",
        "owner": "Dev1",
        "task": "Implement For Adults/Caregivers section in SettingsView.swift",
        "status": "in_progress"
      },
      {
        "id": "ghi789-uuid",
        "owner": "Dev2",
        "task": "Update welcome screen hero icon",
        "status": "pending"
      }
    ],
    "createdAt": "2026-02-28T20:00:00.000Z",
    "updatedAt": "2026-02-28T21:30:00.000Z"
  }
]
```

---

## 3. Server Architecture

### ProjectStore — File-Backed Persistence

```typescript
// server/src/projects/store.ts (key methods)

export class ProjectStore {
  private projects: Project[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load(); // Parse + validate on startup
  }

  // Atomic write: write to .tmp, then rename — prevents corruption mid-write
  private save(): void {
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.projects, null, 2), "utf-8");
    fs.renameSync(tmp, this.filePath);
  }

  create(data: { title, summary, content, assignments? }): Project {
    const project: Project = {
      id: randomUUID(),
      ...data,
      status: "active",
      assignments: data.assignments ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.projects.push(project);
    this.save();
    return project;
  }

  update(id: string, data: Partial<...>): Project | undefined {
    const project = this.projects.find((p) => p.id === id);
    if (!project) return undefined;
    Object.assign(project, data);
    project.updatedAt = new Date().toISOString();
    this.save();
    return project;
  }

  updateAssignmentStatus(
    projectId: string,
    assignmentId: string,
    status: "pending" | "in_progress" | "done"
  ): boolean { ... }

  // KEY: Watch for external changes — bots that edit projects.json directly
  // Uses fs.watchFile() (stat polling) not fs.watch() (inode) because atomic
  // renames swap the inode and silently break fs.watch() after first write.
  watchFile(onChange: (projects: Project[]) => void): (() => void) {
    fs.watchFile(this.filePath, { persistent: false, interval: 500 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      if (curr.mtimeMs === 0) return; // File deleted mid-write — skip
      // Re-parse, call onChange with fresh list
      const fresh = this.reloadFromDisk();
      onChange(fresh);
    });
    return () => fs.unwatchFile(this.filePath);
  }
}
```

### Server Bootstrap (index.ts)

```typescript
// server/src/index.ts

// 1. Instantiate project store
const projectStore = new ProjectStore(config.projectsFile);
// config.projectsFile = path.join(dataDir, "projects.json")

// 2. Mount REST router
app.use("/api/projects", generalLimiter, createProjectsRouter(projectStore));

// 3. Wire auto-task-sync
const taskSyncManager = new TaskSyncManager(projectStore);

// 4. Watch for file changes → broadcast to all clients
projectStore.watchFile((projects) => {
  io.emit("projects:updated", projects);
});

// 5. Intercept task:done to trigger TaskSyncManager
const originalEmit = io.emit.bind(io);
io.emit = ((event, ...args) => {
  if (event === "task:done") {
    taskSyncManager.handleTaskDone(args[0]);
  }
  return originalEmit(event, ...args);
}) as typeof io.emit;
```

---

## 4. REST API

Base path: `/api/projects`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | List all projects (summary view, no `content` field) |
| `GET` | `/:id` | Full project including `content` markdown |
| `POST` | `/` | Create new project |
| `PATCH` | `/:id` | Update any project fields |
| `DELETE` | `/:id` | Delete project |

### POST / — Create Project

```http
POST /api/projects
Content-Type: application/json

{
  "title": "TicBuddy MVP1",
  "summary": "Kid-friendly tic tracking app",
  "content": "## Plan\n\n...",
  "assignments": [
    { "owner": "Dev1", "task": "Implement caregivers section", "status": "pending" }
  ]
}
```

**Required fields:** `title`, `content`
**Optional:** `summary`, `assignments`
**Auto-generated:** `id` (uuid), `status: "active"`, `createdAt`, `updatedAt`

### PATCH /:id — Update Project

```http
PATCH /api/projects/abc123-uuid
Content-Type: application/json

{
  "status": "complete",
  "assignments": [
    { "id": "def456-uuid", "owner": "Dev1", "task": "Caregivers section", "status": "done" }
  ]
}
```

Any subset of fields can be patched. `updatedAt` is always updated automatically.

### Client API Helper (TypeScript)

```typescript
// client/src/api.ts

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const res = await fetch('/api/projects', { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch projects');
  return res.json();
}

export async function fetchProject(id: string): Promise<Project> {
  const res = await fetch(`/api/projects/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Project not found');
  return res.json();
}

export async function createProject(data: {
  title: string;
  summary: string;
  content: string;
  assignments?: Assignment[];
}): Promise<Project> {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create project');
  return res.json();
}

export async function updateProject(id: string, data: Partial<Project>): Promise<Project> {
  const res = await fetch(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update project');
  return res.json();
}
```

---

## 5. Real-Time Sync (Socket.IO)

When `projects.json` changes on disk (by any means — API, bot tool call, direct edit), the server detects the change via `fs.watchFile()` and broadcasts to all connected clients:

```typescript
// Server emits:
io.emit("projects:updated", freshProjectArray);
```

### Client Subscription

```typescript
// client/src/stores/projectStore.ts

// In store initializer (runs once on import):
getSocket().on('projects:updated', (projects: ProjectSummary[]) => {
  set((s) => {
    // Bust cache entries whose updatedAt has changed
    const nextCache = { ...s.projectCache };
    for (const fresh of projects) {
      const cached = nextCache[fresh.id];
      if (cached && cached.updatedAt !== fresh.updatedAt) {
        delete nextCache[fresh.id];  // Force re-fetch of full content
      }
    }
    return { projects, projectCache: nextCache, projectsLoaded: true };
  });
});
```

**Result:** Every connected browser/desktop client reflects project changes within ~500ms of any write, with no polling loop needed.

---

## 6. Client Architecture

### Zustand Store (projectStore.ts)

```typescript
// client/src/stores/projectStore.ts

interface ProjectState {
  projects: ProjectSummary[];          // Summary list (no content)
  activeProjectId: string | null;      // Persisted in localStorage
  projectCache: Record<string, Project>; // Full content cache
  projectsLoaded: boolean;
  projectsError: boolean;
}

// Key: activeProjectId is saved to localStorage so the selected project
// survives page refreshes and app relaunches.
setActiveProject: (id) => {
  if (id) localStorage.setItem('medusa_active_project', id);
  set({ activeProjectId: id });
},

// Cache strategy: summaries always fresh, full content lazy-loaded and cached.
// Cache is busted when updatedAt changes (detected via projects:updated or fetchProjects).
fetchProject: async (id) => {
  const cached = get().projectCache[id];
  if (cached) return cached;           // Cache hit — no round trip
  const project = await api.fetchProject(id);
  set((s) => ({ projectCache: { ...s.projectCache, [id]: project } }));
  return project;
},
```

### UI Component Hierarchy

```
ProjectPane (main tab)
├── ProjectDashboard
│   ├── ProjectDetailCard (per project)
│   │   ├── Header: title, priority badge, status dot, progress bar
│   │   ├── Expanded: grouped assignments (In Progress / Pending / Done)
│   │   └── Edit button → ProjectEditView
│   └── QuickTaskSection
└── ProjectEditView (full edit form)
    ├── Title, summary, status, priority fields
    ├── Content (markdown textarea)
    └── EditableAssignments (owner + task + status per row)

Sidebar
└── ProjectList
    └── Sidebar/ProjectDetailCard (compact version)
```

### Sidebar ProjectList — Sort Order

```typescript
// client/src/components/Sidebar/ProjectList.tsx

const sorted = [...projects].sort((a, b) => {
  // 1. Active before complete
  if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
  // 2. Higher priority first (P0 > P1 > P2 > P3)
  const pa = priorityNum(a.priority), pb = priorityNum(b.priority);
  if (pa !== pb) return pa - pb;
  // 3. Most recently updated first
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
});
```

### Priority Color Coding

```typescript
// P0 = red, P1 = orange, P2 = yellow, P3 = blue/gray
const priorityColors = {
  P0: '#ef4444',  // Red — blocker
  P1: '#f97316',  // Orange — high
  P2: '#eab308',  // Yellow — medium
  P3: '#6b7280',  // Gray — low
};
```

---

## 7. Bot Instructions for Project Management

The PM bot (Medusa) is instructed via its system prompt to be the primary steward of `projects.json`. Key instructions:

### Medusa System Prompt — Project Schema

```
## Creating Projects in projects.json
When creating or updating projects, ALWAYS use this exact schema:
{
  "id": "uuid",
  "title": "Project Name",
  "summary": "Brief description",
  "content": "Full markdown plan body",
  "status": "active" | "complete",
  "priority": "P0" | "P1" | "P2" | "P3",
  "assignments": [
    { "id": "uuid", "owner": "Dev1", "task": "Task description",
      "status": "pending" | "in_progress" | "done" }
  ],
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
Required fields: id, title, summary, content, status, assignments, createdAt, updatedAt.
NEVER use "name" instead of "title".
NEVER use "tasks" instead of "assignments".
NEVER use "assignee" — use "owner".
```

### Medusa System Prompt — Hybrid Pull/Push Task Model

```
## Hybrid Pull/Push Task Model (PM Side)

Default state: New tasks added to projects.json with "owner": "Unassigned". Devs self-select.

Your responsibilities:
1. When a dev posts "@Medusa picking up [task]" → immediately update projects.json:
   set owner to that dev, status to "in_progress", update "updatedAt".
   Respond with confirmation: "📝 Project updated."

2. When a dev posts "[TASK-DONE: description]" → immediately update projects.json:
   set status to "done", update "updatedAt".
   Respond with "📝 Project updated." Then nudge: "Open tasks available — check Projects pane."

3. P0/blocker tasks → send [BOT-TASK: @DevX] direct assignment.
   Do NOT leave these unassigned.

4. NEVER let projects.json go stale. Every status change = immediate file update.
```

### Dev Bot Instructions — Task Pickup Flow

```
## Hybrid Pull/Push Task Model (Dev Side)

PULL (you choose):
- After completing a task, check projects.json for tasks with
  "owner": "Unassigned" and "status": "pending".
- Pick ONE. Post in Hub: "@Medusa picking up [task name]"
- Medusa updates the project tracker. Start working immediately.

PUSH (direct assignment):
- If Medusa sends [BOT-TASK:] with a direct assignment, that takes priority.
- P0/blocker tasks are always push-assigned — drop what you're doing.

Completion flow:
1. Finish work → request QA from @You
2. QA approved → post [TASK-DONE: description] in Hub
3. Immediately check projects.json for next open task
4. Pick up and post "@Medusa picking up [task name]"
```

---

## 8. Auto Task Sync (TASK-DONE Detection)

When any bot posts `[TASK-DONE: description]` in the Hub, `TaskSyncManager` automatically updates the matching project assignment to `"done"`.

### How It Works

```
Bot posts: [HUB-POST: All done! [TASK-DONE: Implement For Adults/Caregivers section]]
  → post-processor.ts detects [TASK-DONE:], extracts description
  → io.emit("task:done", { from: "Dev1", description: "Implement For Adults/Caregivers..." })
  → io.emit override in index.ts intercepts "task:done"
  → taskSyncManager.handleTaskDone(task) called
  → Fuzzy-matches "Dev1" + "caregivers section" against all active assignments
  → If score ≥ 0.6: updateAssignmentStatus(projectId, assignmentId, "done")
  → projects.json written → watchFile detects change
  → io.emit("projects:updated", fresh) → all clients refresh
```

### TaskSyncManager — Fuzzy Matching

```typescript
// server/src/projects/task-sync.ts

private scoreMatch(
  botName: string,    // from [TASK-DONE:] author
  taskDesc: string,   // description in [TASK-DONE: ...]
  assignmentOwner: string,
  assignmentTask: string
): number {
  // Hard requirement: owner must match exactly (case-insensitive)
  if (botName.toLowerCase() !== assignmentOwner.toLowerCase()) return 0;

  // Jaccard similarity on tokenized descriptions
  const taskTokens = new Set(this.tokenize(taskDesc));
  const assignmentTokens = new Set(this.tokenize(assignmentTask));
  const intersection = new Set([...taskTokens].filter(t => assignmentTokens.has(t)));
  const union = new Set([...taskTokens, ...assignmentTokens]);

  return intersection.size / union.size;  // 0.0 – 1.0
}

// Only auto-update if confidence is high enough
const CONFIDENCE_THRESHOLD = 0.6;
if (bestMatch && bestMatch.score >= CONFIDENCE_THRESHOLD) {
  projectStore.updateAssignmentStatus(projectId, assignmentId, "done");
}
```

**Key behaviors:**
- Owner name MUST match exactly — prevents Dev1 accidentally closing Dev2's tasks
- Token overlap threshold prevents false positives on vague descriptions
- Only updates `in_progress` and `pending` assignments (skips already-done)

---

## 9. Quick Tasks (Lightweight Alternative)

For ad-hoc one-off tasks that don't need a full project structure:

```typescript
// server/src/projects/quick-task-store.ts

interface QuickTask {
  id: string;
  title: string;
  assignedTo: string;   // Bot name or "Unassigned"
  status: 'open' | 'done';
  createdAt: string;
  updatedAt: string;
}
```

Detected from Hub posts via `[QUICK-TASK: task title | assigned bot name]`:

```typescript
// server/src/hub/post-processor.ts

const qt = extractQuickTask(postText);
// [QUICK-TASK: Fix login bug | Dev2]
// → { title: "Fix login bug", assignedTo: "Dev2" }
if (qt) {
  const created = quickTaskStore.create(qt);
  io.emit("quick-tasks:updated", quickTaskStore.getAll());
}
```

Client subscribes to `quick-tasks:updated` and renders a `QuickTaskSection` inside the Projects Pane below full projects.

---

## 10. Complete Code Snippets

### Server: Full ProjectStore (condensed)

```typescript
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";

const AssignmentSchema = z.object({
  id: z.string().optional(),
  owner: z.string(),
  task: z.string(),
  status: z.enum(["pending", "in_progress", "done"]),
});

const ProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  content: z.string(),
  status: z.enum(["active", "complete"]),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  assignments: z.array(AssignmentSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class ProjectStore {
  private projects: Project[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private save(): void {
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.projects, null, 2), "utf-8");
    fs.renameSync(tmp, this.filePath);
  }

  getAll(): Project[] { return [...this.projects]; }
  loadAll(): Project[] { return this.getAll(); }

  create(data: { title: string; summary: string; content: string; assignments?: Assignment[] }): Project {
    const now = new Date().toISOString();
    const project: Project = { id: randomUUID(), ...data, status: "active",
      assignments: data.assignments ?? [], createdAt: now, updatedAt: now };
    this.projects.push(project);
    this.save();
    return project;
  }

  update(id: string, data: Partial<...>): Project | undefined {
    const p = this.projects.find((x) => x.id === id);
    if (!p) return undefined;
    Object.assign(p, data);
    p.updatedAt = new Date().toISOString();
    this.save();
    return p;
  }

  watchFile(onChange: (projects: Project[]) => void): () => void {
    fs.watchFile(this.filePath, { persistent: false, interval: 500 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      if (curr.mtimeMs === 0) return;
      // reload and call onChange...
    });
    return () => fs.unwatchFile(this.filePath);
  }
}
```

### Client: Zustand Store (condensed)

```typescript
import { create } from 'zustand';
import { getSocket } from '../socket';

export const useProjectStore = create<ProjectState & ProjectActions>((set, get) => {
  // Real-time sync: server pushes updates when projects.json changes
  getSocket().on('projects:updated', (projects: ProjectSummary[]) => {
    set((s) => {
      // Bust stale cache entries
      const nextCache = { ...s.projectCache };
      for (const fresh of projects) {
        if (s.projectCache[fresh.id]?.updatedAt !== fresh.updatedAt) {
          delete nextCache[fresh.id];
        }
      }
      return { projects, projectCache: nextCache, projectsLoaded: true };
    });
  });

  return {
    projects: [],
    activeProjectId: localStorage.getItem('medusa_active_project') ?? null,
    projectCache: {},
    projectsLoaded: false,
    projectsError: false,

    fetchProjects: async () => {
      const projects = await api.fetchProjects();
      set({ projects, projectsLoaded: true });
    },

    fetchProject: async (id) => {
      const cached = get().projectCache[id];
      if (cached) return cached;
      const project = await api.fetchProject(id);
      set((s) => ({ projectCache: { ...s.projectCache, [id]: project } }));
      return project;
    },

    createProject: async (title, summary, content) => {
      const project = await api.createProject({ title, summary, content, assignments: [] });
      set((s) => ({
        projects: [...s.projects, project],
        projectCache: { ...s.projectCache, [project.id]: project },
        activeProjectId: project.id,
      }));
      return project;
    },

    updateProject: async (id, data) => {
      const updated = await api.updateProject(id, data);
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, ...updated } : p)),
        projectCache: { ...s.projectCache, [id]: updated },
      }));
      return updated;
    },

    setActiveProject: (id) => {
      if (id) localStorage.setItem('medusa_active_project', id);
      else localStorage.removeItem('medusa_active_project');
      set({ activeProjectId: id });
    },
  };
});
```

### Server: REST Router

```typescript
import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { ProjectStore } from "../projects/store.js";

export function createProjectsRouter(projectStore: ProjectStore): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const projects = projectStore.getAll().map((p) => ({
      id: p.id, title: p.title, summary: p.summary,
      status: p.status, priority: p.priority,
      assignments: p.assignments, createdAt: p.createdAt, updatedAt: p.updatedAt,
    }));
    res.json(projects);
  });

  router.get("/:id", (req, res) => {
    const project = projectStore.getById(req.params.id);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    res.json(project);
  });

  router.post("/", (req, res) => {
    const { title, summary, content, assignments } = req.body;
    if (!title || !content) { res.status(400).json({ error: "title and content required" }); return; }
    const project = projectStore.create({
      title: title.trim(), summary: (summary || "").trim(), content: content.trim(),
      assignments: (assignments || []).map((a: any) => ({
        id: a.id || uuidv4(), owner: a.owner || "", task: a.task || "",
        status: a.status || "pending",
      })),
    });
    res.status(201).json(project);
  });

  router.patch("/:id", (req, res) => {
    const updated = projectStore.update(req.params.id, req.body);
    if (!updated) { res.status(404).json({ error: "Project not found" }); return; }
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    const deleted = projectStore.delete(req.params.id);
    if (!deleted) { res.status(404).json({ error: "Project not found" }); return; }
    res.json({ ok: true });
  });

  return router;
}
```

---

## 11. Wiring It All Together

### Environment Variables

```env
# Path to the projects JSON file (relative to server root or absolute)
PROJECTS_FILE=./data/projects.json

# Path to quick tasks JSON file
QUICK_TASKS_FILE=./data/quick-tasks.json
```

### Server Startup Checklist

```typescript
// index.ts — minimum required wiring for project management

// 1. Create stores
const projectStore = new ProjectStore(config.projectsFile);
const quickTaskStore = new QuickTaskStore(config.quickTasksFile);

// 2. Mount API routes
app.use("/api/projects", createProjectsRouter(projectStore));
app.use("/api/quick-tasks", createQuickTasksRouter(quickTaskStore));

// 3. Wire auto-task-sync (TASK-DONE detection)
const taskSyncManager = new TaskSyncManager(projectStore);
const originalEmit = io.emit.bind(io);
io.emit = ((event, ...args) => {
  if (event === "task:done") taskSyncManager.handleTaskDone(args[0]);
  return originalEmit(event, ...args);
}) as typeof io.emit;

// 4. Watch for file changes → push to all clients
projectStore.watchFile((projects) => {
  io.emit("projects:updated", projects);
});
quickTaskStore.watchFile((tasks) => {
  io.emit("quick-tasks:updated", tasks);
});
```

### Client Startup Checklist

```typescript
// App.tsx (or equivalent entry)

// 1. Fetch projects on load
useEffect(() => {
  useProjectStore.getState().fetchProjects();
}, []);

// The socket subscription (projects:updated) is registered
// automatically when projectStore.ts is imported — no extra wiring needed.
```

### Desktop App (WKWebView / Electron)

The desktop app (Medusa.app) is a WKWebView wrapper. It loads the same React bundle served by the Node.js server. No additional project management wiring is needed for desktop — it receives the same `projects:updated` Socket.IO events as the browser client.

**One desktop-specific note:** Clear WKWebView cache on launch to ensure the latest client bundle loads:

```swift
// WebViewController.swift
let cacheTypes: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache]
WKWebsiteDataStore.default().removeData(ofTypes: cacheTypes, modifiedSince: .distantPast) {
  self.doLoadWebApp()
}
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| File-backed JSON (not a DB) | Zero deps, human-readable, bots can edit directly with CLI tools |
| Atomic writes (tmp + rename) | Prevents corruption if the process dies mid-write |
| `fs.watchFile()` not `fs.watch()` | Atomic renames swap inodes — `fs.watch()` silently breaks after first write |
| Per-project Zod validation on load | One corrupt entry skips, not the whole file |
| Cache-busting by `updatedAt` | Content cache stays valid until server confirms a change |
| Summary vs. full content split | Sidebar/list views don't need markdown body — saves bandwidth |
| TaskSyncManager confidence threshold (0.6) | Prevents false positives while catching clear matches |
| Jaccard similarity + exact owner match | Owner match is hard gate; token overlap handles description variation |

---

*Generated from Medusa source — 2026-02-28*
