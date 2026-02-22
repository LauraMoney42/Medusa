import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";

const QuickTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  assignedTo: z.string(),
  status: z.enum(["pending", "in_progress", "done"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type QuickTask = z.infer<typeof QuickTaskSchema>;

/**
 * Persists quick tasks to a JSON file using atomic writes.
 * Same pattern as ProjectStore — lightweight alternative for one-off task tracking.
 */
export class QuickTaskStore {
  private tasks: QuickTask[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;

      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      if (!Array.isArray(raw)) throw new Error("quick-tasks.json root is not an array");

      const loaded: QuickTask[] = [];
      for (let i = 0; i < raw.length; i++) {
        const result = QuickTaskSchema.safeParse(raw[i]);
        if (result.success) {
          loaded.push(result.data);
        } else {
          const title = (raw[i] as Record<string, unknown>)?.title ?? "(no title)";
          console.error(
            `[quick-tasks] ⚠️  Skipping invalid task at index ${i} ("${title}"):`
          );
          for (const issue of result.error.issues) {
            console.error(`  • path: [${issue.path.join(".")}] — ${issue.message}`);
          }
        }
      }

      this.tasks = loaded;
    } catch (err) {
      console.error("[quick-tasks] ⚠️  Could not parse quick-tasks.json:", err);
      this.tasks = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.tasks, null, 2), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error("[quick-tasks] Failed to save:", err);
    }
  }

  getAll(): QuickTask[] {
    return [...this.tasks];
  }

  create(data: { title: string; assignedTo: string }): QuickTask {
    const now = new Date().toISOString();
    const task: QuickTask = {
      id: randomUUID(),
      title: data.title,
      assignedTo: data.assignedTo,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    this.save();
    return task;
  }

  update(
    id: string,
    data: Partial<Pick<QuickTask, "title" | "assignedTo" | "status">>
  ): QuickTask | undefined {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return undefined;

    if (data.title !== undefined) task.title = data.title;
    if (data.assignedTo !== undefined) task.assignedTo = data.assignedTo;
    if (data.status !== undefined) task.status = data.status;
    task.updatedAt = new Date().toISOString();

    this.save();
    return task;
  }

  delete(id: string): boolean {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.tasks.splice(idx, 1);
    this.save();
    return true;
  }

  /**
   * Watch for external changes (same pattern as ProjectStore).
   * Returns cleanup function.
   */
  watchFile(onChange: (tasks: QuickTask[]) => void): () => void {
    fs.watchFile(this.filePath, { persistent: false, interval: 500 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      if (curr.mtimeMs === 0) return;

      try {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        if (!Array.isArray(raw)) throw new Error("quick-tasks.json root is not an array");

        const fresh: QuickTask[] = [];
        for (let i = 0; i < raw.length; i++) {
          const result = QuickTaskSchema.safeParse(raw[i]);
          if (result.success) fresh.push(result.data);
        }

        this.tasks = fresh;
        console.log(`[quick-tasks] Hot-reloaded (${fresh.length} tasks)`);
        onChange(fresh);
      } catch (err) {
        console.error("[quick-tasks] Failed to hot-reload:", err);
      }
    });

    console.log(`[quick-tasks] Watching ${this.filePath} for external changes`);

    return () => {
      fs.unwatchFile(this.filePath);
    };
  }
}
