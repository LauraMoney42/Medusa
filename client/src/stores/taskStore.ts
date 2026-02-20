import { create } from 'zustand';
import type { CompletedTask } from '../types/task';
import * as api from '../api';

interface TaskState {
  completedTasks: CompletedTask[];
}

interface TaskActions {
  addTask: (task: CompletedTask) => void;
  setTasks: (tasks: CompletedTask[]) => void;
  fetchTasks: () => Promise<void>;
  acknowledgeAll: () => Promise<void>;
  clearAll: () => void;
}

export const useTaskStore = create<TaskState & TaskActions>((set) => ({
  completedTasks: [],

  addTask: (task) =>
    set((s) => {
      // Deduplicate by id
      if (s.completedTasks.some((t) => t.id === task.id)) return s;
      return { completedTasks: [...s.completedTasks, task] };
    }),

  setTasks: (tasks) => set({ completedTasks: tasks }),

  fetchTasks: async () => {
    const tasks = await api.fetchTasks();
    set({ completedTasks: tasks });
  },

  acknowledgeAll: async () => {
    await api.acknowledgeTasks();
    set({ completedTasks: [] });
  },

  clearAll: () => set({ completedTasks: [] }),
}));

/** Check if a session has any unacknowledged completed tasks */
export function hasCompletedTask(
  tasks: CompletedTask[],
  sessionId: string,
): boolean {
  return tasks.some((t) => t.sessionId === sessionId && !t.acknowledged);
}
