import { create } from 'zustand';
import type { HubMessage } from '../types/hub';
import * as api from '../api';

interface HubState {
  messages: HubMessage[];
  lastSeenTimestamp: string | null;
  isLoaded: boolean;
}

interface HubActions {
  fetchMessages: () => Promise<void>;
  addMessage: (msg: HubMessage) => void;
  markAllSeen: () => void;
}

export const useHubStore = create<HubState & HubActions>((set, get) => ({
  messages: [],
  lastSeenTimestamp: null,
  isLoaded: false,

  fetchMessages: async () => {
    try {
      const messages = await api.fetchHubMessages();
      set({ messages, isLoaded: true });
    } catch {
      set({ isLoaded: true });
    }
  },

  addMessage: (msg) =>
    set((s) => {
      // Guard against duplicates (e.g. from reconnect or race with fetchMessages)
      if (s.messages.some((m) => m.id === msg.id)) return s;
      return { messages: [...s.messages, msg] };
    }),

  markAllSeen: () => {
    const { messages } = get();
    if (messages.length > 0) {
      const latest = messages[messages.length - 1];
      set({ lastSeenTimestamp: latest.timestamp });
    }
  },
}));

/** Compute unread count: messages after lastSeenTimestamp. */
export function useUnreadHubCount(): number {
  return useHubStore((s) => {
    if (!s.lastSeenTimestamp) return s.messages.length;
    return s.messages.filter((m) => m.timestamp > s.lastSeenTimestamp!).length;
  });
}
