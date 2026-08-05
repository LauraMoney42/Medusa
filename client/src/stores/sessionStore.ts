import { create } from 'zustand';
import type { SessionMeta } from '../types/session';
import * as api from '../api';

interface SessionState {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  activeView: 'hub' | 'project' | 'usage' | 'medusa' | 'arcade' | 'cowork';
  statuses: Record<string, 'idle' | 'busy'>;
  pendingTasks: Record<string, boolean>;
  devControl: Record<string, { paused: boolean; statusRequested: boolean; interrupted: boolean }>;
  isServerShuttingDown: boolean;
  shuttingDownSessions: { id: string; name: string }[];
}

interface SessionActions {
  fetchSessions: () => Promise<void>;
  createSession: (name: string, workingDir?: string, systemPrompt?: string) => Promise<SessionMeta>;
  renameSession: (id: string, name: string) => Promise<void>;
  setSessionModel: (id: string, model: string | null) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  reorderSessions: (order: string[]) => void;
  setActiveSession: (id: string | null) => void;
  setSessionYolo: (id: string, yoloMode: boolean) => void;
  setSessionSystemPrompt: (id: string, systemPrompt: string) => void;
  setSessionSkills: (id: string, skills: string[]) => void;
  setSessionWorkingDir: (id: string, workingDir: string) => void;
  setSessionStatus: (id: string, status: 'idle' | 'busy') => void;
  setPendingTask: (id: string, hasPending: boolean) => void;
  setDevControl: (id: string, state: { paused: boolean; statusRequested: boolean; interrupted: boolean }) => void;
  removeDevControl: (id: string) => void;
  setActiveView: (view: 'hub' | 'project' | 'usage' | 'medusa' | 'arcade' | 'cowork') => void;
  setServerShuttingDown: (busySessions: { id: string; name: string }[]) => void;
}

export const useSessionStore = create<SessionState & SessionActions>(
  (set, get) => ({
    sessions: [],
    activeSessionId: null,
    statuses: {},
    pendingTasks: {},
    devControl: {},
    // Default to medusa — home screen is the Medusa chat pane
    activeView: (() => {
      const stored = localStorage.getItem('medusa_active_view');
      // Restore last saved view if valid; otherwise land on 'medusa' home screen
      if (stored === 'project' || stored === 'usage' || stored === 'hub' || stored === 'medusa' || stored === 'cowork') {
        return stored as 'hub' | 'project' | 'usage' | 'medusa' | 'cowork';
      }
      return 'medusa';
    })(),
    isServerShuttingDown: false,
    shuttingDownSessions: [],

    fetchSessions: async () => {
      const [sessions, devControlList] = await Promise.all([
        api.fetchSessions(),
        api.fetchDevControl().catch(() => [] as api.DevControlState[]),
      ]);
      const devControl: SessionState['devControl'] = {};
      for (const entry of devControlList) {
        devControl[entry.sessionId] = {
          paused: entry.paused,
          statusRequested: entry.statusRequested,
          interrupted: entry.interrupted,
        };
      }
      set({ sessions, devControl });
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

    setSessionModel: async (id, model) => {
      const updated = await api.setSessionModel(id, model);
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
    // Individual bot chat removed — selecting a session no longer switches to chat view
    setActiveSession: (id) =>
      set({ activeSessionId: id }),

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

    setSessionStatus: (id, status) =>
      set((s) => ({
        statuses: { ...s.statuses, [id]: status },
      })),

    setPendingTask: (id, hasPending) =>
      set((s) => ({ pendingTasks: { ...s.pendingTasks, [id]: hasPending } })),

    setDevControl: (id, state) =>
      set((s) => ({ devControl: { ...s.devControl, [id]: state } })),

    removeDevControl: (id) =>
      set((s) => {
        const next = { ...s.devControl };
        delete next[id];
        return { devControl: next };
      }),

    setActiveView: (view) => {
      localStorage.setItem('medusa_active_view', view);
      set({ activeView: view });
    },

    setServerShuttingDown: (busySessions) =>
      set({ isServerShuttingDown: true, shuttingDownSessions: busySessions }),
  }),
);
