import { create } from 'zustand';
import type { QuickTask } from '../types/project';
import * as api from '../api';
import { getSocket } from '../socket';

interface QuickTaskState {
  tasks: QuickTask[];
  loaded: boolean;
  error: boolean;
}

interface QuickTaskActions {
  fetchTasks: () => Promise<void>;
  createTask: (title: string, assignedTo: string) => Promise<QuickTask>;
  updateTask: (id: string, data: Partial<Pick<QuickTask, 'title' | 'assignedTo' | 'status'>>) => Promise<QuickTask>;
  deleteTask: (id: string) => Promise<void>;
}

export const useQuickTaskStore = create<QuickTaskState & QuickTaskActions>(
  (set) => {
    // Real-time sync via Socket.IO — same pattern as projectStore
    getSocket().on('quick-tasks:updated', (tasks: QuickTask[]) => {
      set({ tasks, loaded: true, error: false });
    });

    return {
      tasks: [],
      loaded: false,
      error: false,

      fetchTasks: async () => {
        try {
          const tasks = await api.fetchQuickTasks();
          set({ tasks, loaded: true, error: false });
        } catch (err) {
          console.error('[quick-tasks] fetch failed:', err);
          set({ loaded: true, error: true });
        }
      },

      createTask: async (title: string, assignedTo: string) => {
        const task = await api.createQuickTask({ title, assignedTo });
        set((s) => ({ tasks: [...s.tasks, task] }));
        return task;
      },

      updateTask: async (id, data) => {
        const updated = await api.updateQuickTask(id, data);
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? updated : t)),
        }));
        return updated;
      },

      deleteTask: async (id) => {
        await api.deleteQuickTask(id);
        set((s) => ({
          tasks: s.tasks.filter((t) => t.id !== id),
        }));
      },
    };
  }
);
