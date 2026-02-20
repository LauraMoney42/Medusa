import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";

// Zod schemas validate the structure of data read from disk.
// If the file is corrupt or has unexpected shape, parse() throws and
// the caller's catch block resets to a safe empty state.

const AssignmentSchema = z.object({
  // id was added after many assignments were created without one.
  // Making it optional allows legacy data to load; we backfill missing ids at load time.
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

export type Assignment = z.infer<typeof AssignmentSchema>;
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Persists projects to a JSON file using atomic writes.
 * Same pattern as HubStore and SessionStore.
 */
export class ProjectStore {
  private projects: Project[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;

      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      if (!Array.isArray(raw)) throw new Error("projects.json root is not an array");

      // P1-C: Per-project isolation — one invalid project is skipped and logged,
      // not allowed to discard the entire list. Previously a single bad field
      // (missing `content`, unknown `priority` value, etc.) silently zeroed all projects.
      const loaded: Project[] = [];
      for (let i = 0; i < raw.length; i++) {
        const result = ProjectSchema.safeParse(raw[i]);
        if (result.success) {
          loaded.push(result.data);
        } else {
          // P1-B: Loud, specific logging so the bad entry is findable without server log expertise.
          const title = (raw[i] as Record<string, unknown>)?.title ?? `(no title)`;
          console.error(
            `[projects] ⚠️  Skipping invalid project at index ${i} ("${title}") — fix projects.json to restore it:`
          );
          for (const issue of result.error.issues) {
            console.error(`  • path: [${issue.path.join(".")}] — ${issue.message}`);
          }
        }
      }

      // One-time migration: backfill missing assignment ids from before the id field was added.
      // Without ids, drag-and-drop PATCH calls can't target specific assignments.
      let needsSave = false;
      for (const project of loaded) {
        for (const assignment of project.assignments) {
          if (!assignment.id) {
            assignment.id = randomUUID();
            needsSave = true;
          }
        }
      }

      this.projects = loaded;
      if (needsSave) {
        console.log("[projects] Backfilled missing assignment ids — saving");
        this.save();
      }
    } catch (err) {
      console.error("[projects] ⚠️  STARTUP FAILURE — could not parse projects.json:", err);
      this.projects = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Atomic write: write to temp file, then rename
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.projects, null, 2), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error("[projects] Failed to save projects file:", err);
    }
  }

  getAll(): Project[] {
    return [...this.projects];
  }

  getById(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  create(data: {
    title: string;
    summary: string;
    content: string;
    assignments?: Assignment[];
  }): Project {
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      title: data.title,
      summary: data.summary,
      content: data.content,
      status: "active",
      assignments: data.assignments ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.projects.push(project);
    this.save();
    return project;
  }

  update(
    id: string,
    data: Partial<Pick<Project, "title" | "summary" | "content" | "status" | "priority" | "assignments">>
  ): Project | undefined {
    const project = this.projects.find((p) => p.id === id);
    if (!project) return undefined;

    if (data.title !== undefined) project.title = data.title;
    if (data.summary !== undefined) project.summary = data.summary;
    if (data.content !== undefined) project.content = data.content;
    if (data.status !== undefined) project.status = data.status;
    if (data.priority !== undefined) project.priority = data.priority;
    if (data.assignments !== undefined) project.assignments = data.assignments;
    project.updatedAt = new Date().toISOString();

    this.save();
    return project;
  }

  delete(id: string): boolean {
    const idx = this.projects.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.projects.splice(idx, 1);
    this.save();
    return true;
  }

  /**
   * Update a specific assignment's status within a project.
   * Returns true if update succeeded, false if project or assignment not found.
   */
  updateAssignmentStatus(
    projectId: string,
    assignmentId: string,
    status: "pending" | "in_progress" | "done"
  ): boolean {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return false;

    const assignment = project.assignments.find((a) => a.id === assignmentId);
    if (!assignment) return false;

    assignment.status = status;
    project.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  /** Helper: load all projects (alias for getAll, used by task-sync) */
  loadAll(): Project[] {
    return this.getAll();
  }

  /**
   * Watch the projects file for external changes (e.g., a bot editing projects.json directly).
   * When a change is detected, reloads from disk and calls `onChange` with the fresh project list.
   *
   * Uses `fs.watchFile()` (stat polling) instead of `fs.watch()` (inode-based) because
   * `save()` does an atomic rename (tmp → projects.json), which swaps the inode and silently
   * orphans `fs.watch()` after the first write. `fs.watchFile()` tracks by filename and survives
   * atomic renames.
   *
   * Returns a cleanup function to stop watching (calls `fs.unwatchFile()`).
   */
  watchFile(onChange: (projects: Project[]) => void): (() => void) {
    // Poll every 500ms — fast enough for dev experience, cheap enough to run continuously.
    fs.watchFile(this.filePath, { persistent: false, interval: 500 }, (curr, prev) => {
      // Only reload if the file actually changed (mtime or size differs).
      // This filters out spurious stat calls that return identical metadata.
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;

      // File was deleted (e.g., mid-write) — skip until it reappears.
      if (curr.mtimeMs === 0) return;

      try {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        if (!Array.isArray(raw)) throw new Error("projects.json root is not an array");

        // Same per-project isolation as load() — one bad entry is skipped, not the whole file.
        const fresh: Project[] = [];
        for (let i = 0; i < raw.length; i++) {
          const result = ProjectSchema.safeParse(raw[i]);
          if (result.success) {
            fresh.push(result.data);
          } else {
            const title = (raw[i] as Record<string, unknown>)?.title ?? `(no title)`;
            console.error(`[projects] Hot-reload: skipping invalid project "${title}" at index ${i}`);
          }
        }

        this.projects = fresh;
        console.log(`[projects] Hot-reloaded projects.json from disk (${fresh.length} projects)`);
        onChange(fresh);
      } catch (err) {
        console.error("[projects] Failed to hot-reload projects.json:", err);
      }
    });

    console.log(`[projects] Watching ${this.filePath} for external changes (polling)`);

    // Return a cleanup function for graceful shutdown.
    return () => {
      fs.unwatchFile(this.filePath);
    };
  }
}
