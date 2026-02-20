import type { ProjectStore } from "./store.js";
import type { CompletedTask } from "../hub/store.js";

/**
 * TaskSyncManager automatically updates project assignments when devs post [TASK-DONE:].
 * Listens for task:done events, fuzzy-matches to project assignments, and PATCHes status to "done".
 */
export class TaskSyncManager {
  private projectStore: ProjectStore;

  constructor(projectStore: ProjectStore) {
    this.projectStore = projectStore;
  }

  /**
   * Handle a task:done event from the Hub.
   * Fuzzy-match the task to project assignments and auto-update status.
   */
  handleTaskDone(task: CompletedTask): void {
    const { from: botName, description } = task;

    console.log(`[task-sync] Processing [TASK-DONE:] from ${botName}: "${description}"`);

    // Load all active projects
    const allProjects = this.projectStore.loadAll();
    const activeProjects = allProjects.filter((p) => p.status !== "complete");

    if (activeProjects.length === 0) {
      console.log("[task-sync] No active projects to match against");
      return;
    }

    // Find best matching assignment across all active projects
    let bestMatch: {
      projectId: string;
      assignmentId: string;
      score: number;
    } | null = null;

    for (const project of activeProjects) {
      if (!project.assignments || project.assignments.length === 0) continue;

      for (const assignment of project.assignments) {
        // Skip already-done assignments
        if (assignment.status === "done") continue;

        // id is backfilled at load time; skip defensively if somehow still missing
        if (!assignment.id) continue;

        // Score this assignment
        const score = this.scoreMatch(botName, description, assignment.owner, assignment.task);

        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = {
            projectId: project.id,
            assignmentId: assignment.id,
            score,
          };
        }
      }
    }

    // Apply the best match if confidence is high enough
    const CONFIDENCE_THRESHOLD = 0.6;
    if (bestMatch && bestMatch.score >= CONFIDENCE_THRESHOLD) {
      console.log(
        `[task-sync] ✅ Match found (score: ${bestMatch.score.toFixed(2)}) — updating assignment ${bestMatch.assignmentId} in project ${bestMatch.projectId}`
      );
      this.projectStore.updateAssignmentStatus(
        bestMatch.projectId,
        bestMatch.assignmentId,
        "done"
      );
    } else if (bestMatch) {
      console.warn(
        `[task-sync] ⚠️ Low-confidence match (score: ${bestMatch.score.toFixed(2)}) — skipping auto-update for "${description}"`
      );
    } else {
      console.warn(
        `[task-sync] ⚠️ No match found for [TASK-DONE:] from ${botName}: "${description}"`
      );
    }
  }

  /**
   * Score how well a task description matches an assignment.
   * Returns a value between 0 (no match) and 1 (perfect match).
   *
   * Matching criteria:
   * - Owner name must match exactly (case-insensitive)
   * - Task description must have >= 50% token overlap with assignment description
   */
  private scoreMatch(
    botName: string,
    taskDesc: string,
    assignmentOwner: string,
    assignmentTask: string
  ): number {
    // Owner name must match exactly
    if (botName.toLowerCase() !== assignmentOwner.toLowerCase()) {
      return 0;
    }

    // Tokenize descriptions (split on whitespace + punctuation, lowercase)
    const taskTokens = this.tokenize(taskDesc);
    const assignmentTokens = this.tokenize(assignmentTask);

    if (taskTokens.length === 0 || assignmentTokens.length === 0) {
      return 0;
    }

    // Calculate token overlap (Jaccard similarity)
    const taskSet = new Set(taskTokens);
    const assignmentSet = new Set(assignmentTokens);
    const intersection = new Set(
      [...taskSet].filter((t) => assignmentSet.has(t))
    );
    const union = new Set([...taskSet, ...assignmentSet]);

    const overlap = intersection.size / union.size;

    // Boost score if there's high overlap
    return overlap;
  }

  /**
   * Tokenize a string into lowercase alphanumeric tokens.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 0);
  }
}
