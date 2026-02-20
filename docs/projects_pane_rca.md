# RCA: Projects Pane Disappears on Restart

**Date:** 2026-02-19
**Author:** Full Stack Dev
**Severity:** P0
**Status:** Investigation complete — awaiting PM2 review before fixes ship

---

## 1. Full Startup Sequence Trace

### Server side

```
1. index.ts executes → new ProjectStore(config.projectsFile)
   config.projectsFile = ~/.claude-chat/projects.json

2. ProjectStore constructor → this.load() (synchronous)

3. load():
   a. fs.existsSync(filePath)         → true (file present)
   b. fs.readFileSync(filePath)        → raw JSON string
   c. JSON.parse(raw)                  → JS array
   d. ProjectsFileSchema.parse(array)  → Zod validates ENTIRE array atomically
      ↳ PASS: this.projects = validated array (with id backfill if needed)
      ↳ FAIL on ANY project: ZodError thrown
        → catch: console.error(...), this.projects = []
        → server continues, no crash, no retry, no shutdown
        → server is now in "quietly broken" state

4. Express mounts /api/projects → calls projectStore.getAll() → returns []
   GET /api/projects returns HTTP 200 with body []
   (identical response to a legitimate empty project list)

5. projectStore.watchFile() starts polling every 500ms
   → on file change: re-runs same parse (same failure mode applies to hot-reloads)
```

### Client side

```
6. Medusa.app WKWebView loads → App.tsx mounts
   → checkAuth() → GET /api/auth/me
   → auth succeeds → AuthenticatedApp mounts

7. useEffect (mount + socket reconnect):
   → fetchProjects() → GET /api/projects

8. fetchProjects():
   → receives HTTP 200 with body []
   → set({ projects: [], projectsLoaded: true, projectsError: false })
   ↳ projectsError = false because the HTTP request SUCCEEDED
   ↳ There is no HTTP-level signal that the server had a load failure

9. ProjectList renders:
   a. if (!projectsLoaded) return null      ← loading state (never reached)
   b. if (projects.length === 0) return null ← hides section entirely
   ↳ User sees: blank sidebar, no error, no message, no retry
```

---

## 2. Failure Mode Map — The Three Fixes This Session

### Fix 1 (this session): AssignmentSchema `id` optional + backfill migration

**What broke:** Assignments created before the `id` field existed had no `id` field. `AssignmentSchema` required `id: z.string()`. Zod threw on first assignment without an id.

**What the fix did:** Changed `id: z.string()` → `id: z.string().optional()`. Added a one-time migration in `load()` that backfills missing ids and saves to disk. `task-sync.ts` got a `!assignment.id` guard for TypeScript.

**Why the pane disappeared again:** The fix only addressed the `id` field. It did not address that the schema has multiple required fields (`content`, `summary`, `status` values, `priority` values) that can fail in the same way. The next schema violation was already waiting.

**What it missed:** The structural problem — one bad field on one project fails all 28. The fix patched one violation without hardening the system against the next one.

---

### Fix 2 (this session): P3 priority enum extension

**What broke:** A new project had `priority: "P3"`. The enum only allowed `["P0","P1","P2"]`. Zod threw.

**What the fix did:** Extended enum to `["P0","P1","P2","P3"]`. Updated client types, `api.ts`, `ProjectPane.tsx` dropdown.

**Why the pane disappeared again:** The schema still has other required fields (`content`) that new bot-created projects omit. Same failure mode, different field.

**What it missed:** `content` is required (`z.string()`). Project[27] "P1: Project Detail View" — the newest project record written directly to projects.json — has no `content` field. This will trigger ZodError on the next server restart.

**IMMINENT FAILURE CONFIRMED:** Running `python3` audit against current projects.json right now:
```
Project[27] "P1: Project Detail View": content=MISSING
```
The next server restart will break the Projects pane again without this being fixed.

---

### Fix 3 (earlier session): `projectsLoaded` gate in ProjectList / KanbanStrip fixes

**What it did:** Added `if (!projectsLoaded) return null` to prevent false-empty flash during initial load. Fixed KanbanStrip botName matching. Added `projectsError` state to store.

**Why it didn't prevent recurrence:** These are client-side rendering improvements. The server-side schema failure makes the client receive `[]` with HTTP 200 — the client has no way to detect this as a failure. `projectsError` is only set if the HTTP request itself throws (network error, 4xx/5xx), not if the server returns a valid empty array due to internal failure.

---

## 3. Silent Failure Audit

Every single layer swallows the failure without user-visible signal:

| Layer | Failure event | Behavior | User sees |
|-------|--------------|----------|-----------|
| `ProjectStore.load()` | ZodError on parse | `console.error()` + `this.projects = []` | Nothing (server log only) |
| `GET /api/projects` | Store has `[]` | Returns **HTTP 200** with `[]` | Nothing |
| `fetchProjects()` client | Gets `[]` from 200 response | Sets `projectsError: false`, `projects: []` | Nothing |
| `ProjectList` | `projects.length === 0` | `return null` — identical to loading | Nothing |
| `projectsError: true` flag | Set on network/HTTP errors | **Never read by any UI component** | Nothing |

**The lethal combination:**
- A ZodError produces the same API response as a genuinely empty project list
- The client's error flag (`projectsError`) only fires for HTTP failures, not for "server returned empty due to internal failure"
- `ProjectList` treats loading, empty, and error identically — all three return `null`

**Additional silent failure — PATCH route writes unvalidated data:**
```typescript
// routes/projects.ts
router.patch("/:id", (req, res) => {
  const updated = projectStore.update(req.params.id, req.body); // req.body not validated
```
A bot can PATCH a project with `priority: "P4"`, `status: "done"` (invalid for projects), or missing required fields. The store saves it. The next startup breaks.

---

## 4. Reproduction Recipe

### Confirmed reliable reproduction:

**Step 1:** Any bot or PM writes a project record directly to `~/.claude-chat/projects.json` with a field that fails the current schema:
- Missing `content` field (currently present in Project[27])
- Invalid `priority` value (e.g. "P4")
- Invalid `status` value (e.g. "done" instead of "active"/"complete")
- Any other schema violation

This happens routinely — PM2 and bots write project records directly to the JSON file, bypassing the POST /api/projects validation.

**Step 2:** Server restarts (rebuild, stop-all, or Medusa.app relaunch).

**Step 3:** `ProjectStore.load()` runs. `ProjectsFileSchema.parse()` throws on the invalid record. `this.projects = []`.

**Step 4:** Client's `GET /api/projects` returns `HTTP 200 []`.

**Step 5:** `ProjectList` renders `null`. Projects pane disappears with no indication of failure.

### Why it's hard to diagnose:
- Error only appears in the server terminal log — not visible in the Medusa.app UI
- WKWebView DevTools don't show server logs by default
- The UI symptom (blank pane) is identical whether load failed or there are genuinely no projects
- `projectsError: true` is set in the store but no component reads it

---

## 5. True Root Cause

**There are two independent root causes:**

> **Root Cause A (primary — structural):** `ProjectsFileSchema.parse()` validates the entire 28-project array atomically. A single invalid field on a single project silently discards all 28 projects. The schema is written for an idealized world where all data is well-formed, but projects.json is written directly by bots and PMs who regularly omit optional-seeming fields like `content`.

> **Root Cause B (amplifier — observability):** The server serves `HTTP 200 []` on load failure, which is indistinguishable from a legitimate empty list. The client's `projectsError` flag only fires on HTTP-level failures, not on "valid response that is empty due to internal corruption." Every layer between the ZodError and the user produces a valid-looking no-data signal.

Root Cause A creates the failure. Root Cause B makes it look like correct behavior and makes debugging require direct server log access.

---

## 6. Fix Recommendations

**These are recommendations only. No code ships until PM2 approves.**

### Fix A1 — Per-project error isolation (addresses Root Cause A, highest impact)

Replace the all-or-nothing parse with per-project `safeParse`, skipping bad entries and logging them individually:

```typescript
private load(): void {
  try {
    if (!fs.existsSync(this.filePath)) return;
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    if (!Array.isArray(raw)) throw new Error("projects.json is not an array");

    const loaded: Project[] = [];
    for (let i = 0; i < raw.length; i++) {
      const result = ProjectSchema.safeParse(raw[i]);
      if (result.success) {
        loaded.push(result.data);
      } else {
        // One bad project is logged and skipped — the other 27 still load
        console.error(`[projects] Skipping invalid project at index ${i}:`, result.error.issues);
      }
    }
    this.projects = loaded;
    // ... backfill ids, save if needed
  } catch (err) {
    console.error("[projects] Failed to load projects file:", err);
    this.projects = [];
  }
}
```

**Effect:** One bad project is skipped. All others load. Projects pane shows 27 projects instead of 0. The skipped project is visible in server logs.

### Fix A2 — Make `content` optional with default (addresses imminent failure)

```typescript
const ProjectSchema = z.object({
  // ...
  content: z.string().optional().default(''),  // bots often omit this
  summary: z.string().optional().default(''),  // same risk
  // ...
});
```

**This is a band-aid if used alone.** Combined with Fix A1, it removes the most common violations while A1 handles anything we haven't anticipated.

### Fix B — Surface load failures to the client (addresses Root Cause B)

Add a `projects:load-error` socket event emitted when `this.projects` is reset due to a parse failure. Client listens and sets `projectsError: true` directly, without needing the HTTP response to signal failure:

```typescript
// In load(), after the catch resets to []:
// (after io is initialized) io.emit("projects:load-error", { message: "..." });
```

Also: `ProjectList` should render a distinct error state when `projectsError` is true:

```tsx
if (projectsError) return (
  <div style={styles.errorState}>
    Projects failed to load — check server logs
    <button onClick={fetchProjects}>Retry</button>
  </div>
);
```

### Fix C — Validate PATCH route input (prevents future corruption via API)

```typescript
router.patch("/:id", (req, res) => {
  const body = PatchProjectSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error }); return; }
  const updated = projectStore.update(req.params.id, body.data);
  // ...
});
```

### Priority order:

| Fix | Impact | Effort | Recommended order |
|-----|--------|--------|-------------------|
| A1 (per-project safeParse) | Eliminates recurrence | Small | 1st — do this first |
| A2 (content optional) | Fixes imminent failure immediately | Tiny | 1st (alongside A1) |
| B (client error signal) | Makes failures visible | Small | 2nd |
| C (PATCH validation) | Prevents future corruption at write time | Small | 3rd |

---

## Appendix: Files

| File | Role in failure |
|------|----------------|
| `server/src/projects/store.ts` | All-or-nothing Zod parse — primary failure point |
| `server/src/routes/projects.ts` | Returns HTTP 200 `[]` on load failure — no error signal |
| `client/src/stores/projectStore.ts` | `projectsError` set only on HTTP failure, not on empty-from-failure |
| `client/src/components/Sidebar/ProjectList.tsx` | `projects.length === 0` treated same as loading and error |
| `~/.claude-chat/projects.json` | Written directly by bots/PMs — bypasses POST validation |
