import { create } from 'zustand';
import type { SessionMeta } from '../types/session';
import * as api from '../api';

/**
 * The views the main column can show. Browser and Simulator are no longer
 * views: they live in the right-hand panel (see stores/layoutStore.ts), so a
 * chat stays on screen beside them.
 */
export type ActiveView = 'chat' | 'project' | 'tools';

const VIEW_KEY = 'medusa_active_view';
const VALID_VIEWS: ActiveView[] = ['chat', 'project', 'tools'];

interface SessionState {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  activeView: ActiveView;
  statuses: Record<string, 'idle' | 'busy'>;
  isServerShuttingDown: boolean;
  shuttingDownSessions: { id: string; name: string }[];
}

interface SessionActions {
  fetchSessions: () => Promise<void>;
  createSession: (input: api.CreateSessionInput) => Promise<SessionMeta>;
  renameSession: (id: string, name: string) => Promise<void>;
  setSessionModel: (id: string, model: string | null) => Promise<void>;
  updateSession: (
    id: string,
    patch: Parameters<typeof api.updateSession>[1],
  ) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  reorderSessions: (order: string[]) => void;
  setActiveSession: (id: string | null) => void;
  setSessionYolo: (id: string, yoloMode: boolean) => void;
  setSessionSystemPrompt: (id: string, systemPrompt: string) => void;
  setSessionSkills: (id: string, skills: string[]) => void;
  setSessionWorkingDir: (id: string, workingDir: string) => void;
  setSessionStatus: (id: string, status: 'idle' | 'busy') => void;
  setActiveView: (view: ActiveView) => void;
  setServerShuttingDown: (busySessions: { id: string; name: string }[]) => void;
}

export const useSessionStore = create<SessionState & SessionActions>(
  (set, get) => ({
    sessions: [],
    activeSessionId: (() => localStorage.getItem('medusa_active_session'))(),
    statuses: {},
    activeView: (() => {
      const stored = localStorage.getItem(VIEW_KEY) as ActiveView | null;
      return stored && VALID_VIEWS.includes(stored) ? stored : 'chat';
    })(),
    isServerShuttingDown: false,
    shuttingDownSessions: [],

    fetchSessions: async () => {
      const sessions = await api.fetchSessions();
      set({ sessions });
      // Keep the restored active chat honest: if it was deleted elsewhere,
      // fall back to the first chat rather than rendering an empty pane.
      const { activeSessionId } = get();
      if (!activeSessionId || !sessions.some((s) => s.id === activeSessionId)) {
        get().setActiveSession(sessions[0]?.id ?? null);
      }
    },

    createSession: async (input) => {
      const session = await api.createSession(input);
      set((s) => ({ sessions: [...s.sessions, session] }));
      return session;
    },

    renameSession: async (id, name) => {
      const updated = await api.renameSession(id, name);
      set((s) => ({
        sessions: s.sessions.map((sess) => (sess.id === id ? updated : sess)),
      }));
    },

    setSessionModel: async (id, model) => {
      const updated = await api.setSessionModel(id, model);
      set((s) => ({
        sessions: s.sessions.map((sess) => (sess.id === id ? updated : sess)),
      }));
    },

    updateSession: async (id, patch) => {
      const updated = await api.updateSession(id, patch);
      set((s) => ({
        sessions: s.sessions.map((sess) => (sess.id === id ? updated : sess)),
      }));
    },

    deleteSession: async (id) => {
      await api.deleteSession(id);
      const state = get();
      const remaining = state.sessions.filter((s) => s.id !== id);
      set({ sessions: remaining });
      if (state.activeSessionId === id) {
        get().setActiveSession(remaining[0]?.id ?? null);
      }
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

    // Selecting a chat is how you get to a chat now, so this also switches the
    // main column back to the chat view.
    setActiveSession: (id) => {
      if (id) localStorage.setItem('medusa_active_session', id);
      else localStorage.removeItem('medusa_active_session');
      set({ activeSessionId: id });
    },

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

    setActiveView: (view) => {
      localStorage.setItem(VIEW_KEY, view);
      set({ activeView: view });
    },

    setServerShuttingDown: (busySessions) =>
      set({ isServerShuttingDown: true, shuttingDownSessions: busySessions }),
  }),
);
