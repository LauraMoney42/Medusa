import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MAX_HISTORY = 50;

interface InputHistoryState {
  /** Persisted: sent messages per scope (newest last). Scope is "hub" or a sessionId. */
  history: Record<string, string[]>;

  // Transient navigation state (not persisted)
  _index: Record<string, number>;   // -1 = not navigating
  _stash: Record<string, string>;   // unsent text saved on first Up press

  push: (scope: string, text: string) => void;
  up: (scope: string, currentText: string) => string | null;
  down: (scope: string) => string | null;
  resetNav: (scope: string) => void;
}

export const useInputHistoryStore = create<InputHistoryState>()(
  persist(
    (set, get) => ({
      history: {},
      _index: {},
      _stash: {},

      push: (scope, text) =>
        set((state) => {
          const prev = state.history[scope] ?? [];
          // Skip consecutive duplicates
          if (prev.length > 0 && prev[prev.length - 1] === text) {
            return state;
          }
          const next = [...prev, text].slice(-MAX_HISTORY);
          return {
            history: { ...state.history, [scope]: next },
            // Reset navigation on push
            _index: { ...state._index, [scope]: -1 },
            _stash: { ...state._stash, [scope]: '' },
          };
        }),

      up: (scope, currentText) => {
        const state = get();
        const entries = state.history[scope];
        if (!entries || entries.length === 0) return null;

        let idx = state._index[scope] ?? -1;

        // First press: stash current text and start at end of history
        if (idx === -1) {
          idx = entries.length - 1;
          set({
            _index: { ...state._index, [scope]: idx },
            _stash: { ...state._stash, [scope]: currentText },
          });
          return entries[idx];
        }

        // Already navigating: move back if possible
        if (idx > 0) {
          idx -= 1;
          set({ _index: { ...state._index, [scope]: idx } });
          return entries[idx];
        }

        // At oldest entry, don't wrap
        return null;
      },

      down: (scope) => {
        const state = get();
        const entries = state.history[scope];
        if (!entries || entries.length === 0) return null;

        const idx = state._index[scope] ?? -1;
        if (idx === -1) return null; // Not navigating

        if (idx < entries.length - 1) {
          // Move forward in history
          const newIdx = idx + 1;
          set({ _index: { ...state._index, [scope]: newIdx } });
          return entries[newIdx];
        }

        // Past the newest entry: restore stashed text and exit nav
        set({
          _index: { ...state._index, [scope]: -1 },
        });
        return state._stash[scope] ?? '';
      },

      resetNav: (scope) => {
        const state = get();
        if ((state._index[scope] ?? -1) === -1) return; // already reset
        set({
          _index: { ...state._index, [scope]: -1 },
          _stash: { ...state._stash, [scope]: '' },
        });
      },
    }),
    {
      name: 'medusa-input-history',
      partialize: (state) => ({ history: state.history }),
    }
  )
);
