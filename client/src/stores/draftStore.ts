import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface DraftState {
  drafts: Record<string, string>;

  setDraft: (botId: string, text: string) => void;
  clearDraft: (botId: string) => void;
  getDraft: (botId: string) => string;
}

export const useDraftStore = create<DraftState>()(
  persist(
    (set, get) => ({
      drafts: {},

      setDraft: (botId, text) =>
        set((state) => ({
          drafts: {
            ...state.drafts,
            [botId]: text,
          },
        })),

      // Clear a chat's draft (on successful send, or a manual input clear)
      clearDraft: (botId) =>
        set((state) => {
          const next = { ...state.drafts };
          delete next[botId];
          return { drafts: next };
        }),

      getDraft: (botId) => get().drafts[botId] ?? '',
    }),
    {
      name: 'medusa-drafts',
      // Persist only the drafts record — actions are always recreated at runtime
      partialize: (state) => ({ drafts: state.drafts }),
    }
  )
);
