import { create } from 'zustand';
import type { SessionMeta } from '../types/session';
import * as api from '../api';

interface SessionState {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  statuses: Record<string, 'idle' | 'busy'>;
  pendingTasks: Record<string, boolean>;
  activeView: 'chat' | 'hub' | 'project';
  isServerShuttingDown: boolean;
  shuttingDownSessions: { id: string; name: string }[];
}

interface SessionActions {
  fetchSessions: () => Promise<void>;
  createSession: (name: string, workingDir?: string, systemPrompt?: string) => Promise<SessionMeta>;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  reorderSessions: (order: string[]) => void;
  setActiveSession: (id: string | null) => void;
  setSessionStatus: (id: string, status: 'idle' | 'busy') => void;
  setSessionYolo: (id: string, yoloMode: boolean) => void;
  setSessionSystemPrompt: (id: string, systemPrompt: string) => void;
  setSessionSkills: (id: string, skills: string[]) => void;
  setSessionWorkingDir: (id: string, workingDir: string) => void;
  setPendingTask: (id: string, hasPending: boolean) => void;
  setActiveView: (view: 'chat' | 'hub' | 'project') => void;
  setServerShuttingDown: (busySessions: { id: string; name: string }[]) => void;
}

export const useSessionStore = create<SessionState & SessionActions>(
  (set, get) => ({
    sessions: [],
    activeSessionId: null,
    statuses: {},
    pendingTasks: {},
    activeView: (localStorage.getItem('medusa_active_view') as 'chat' | 'hub' | 'project') ?? 'chat',
    isServerShuttingDown: false,
    shuttingDownSessions: [],

    fetchSessions: async () => {
      const sessions = await api.fetchSessions();
      set({ sessions });
    },

    createSession: async (name, workingDir, systemPrompt) => {
      const session = await api.createSession(name, workingDir, systemPrompt);
      set((s) => ({ sessions: [...s.sessions, session] }));
      return session;
    },

    renameSession: async (id, name) => {
      const updated = await api.renameSession(id, name);
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === id ? updated : sess,
        ),
      }));
    },

    deleteSession: async (id) => {
      await api.deleteSession(id);
      const state = get();
      set({
        sessions: state.sessions.filter((s) => s.id !== id),
        activeSessionId:
          state.activeSessionId === id ? null : state.activeSessionId,
      });
    },

    reorderSessions: (order) => {
      set((s) => {
        const map = new Map(s.sessions.map((sess) => [sess.id, sess]));
        const reordered = order
          .map((id) => map.get(id))
          .filter((s): s is SessionMeta => s != null);
        return { sessions: reordered };
      });
      api.reorderSessions(order).catch(console.error);
    },

    // Passing null clears the selection without forcing a view change (e.g. when switching to Hub)
    setActiveSession: (id) =>
      id === null
        ? set({ activeSessionId: null })
        : set({ activeSessionId: id, activeView: 'chat' }),

    setSessionStatus: (id, status) =>
      set((s) => ({ statuses: { ...s.statuses, [id]: status } })),

    setSessionYolo: (id, yoloMode) =>
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === id ? { ...sess, yoloMode } : sess,
        ),
      })),

    setSessionSystemPrompt: (id, systemPrompt) =>
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === id ? { ...sess, systemPrompt: systemPrompt || undefined } : sess,
        ),
      })),

    setSessionSkills: (id, skills) =>
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === id ? { ...sess, skills: skills.length > 0 ? skills : undefined } : sess,
        ),
      })),

    setSessionWorkingDir: (id, workingDir) =>
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === id ? { ...sess, workingDir } : sess,
        ),
      })),

    setPendingTask: (id, hasPending) =>
      set((s) => ({ pendingTasks: { ...s.pendingTasks, [id]: hasPending } })),

    setActiveView: (view) => {
      localStorage.setItem('medusa_active_view', view);
      set({ activeView: view });
    },

    setServerShuttingDown: (busySessions) =>
      set({ isServerShuttingDown: true, shuttingDownSessions: busySessions }),
  }),
);
