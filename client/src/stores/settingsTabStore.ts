import { create } from 'zustand';

/**
 * Cross-component "switch to this Settings tab" signal (W8). VoiceTab's
 * "Add your Gemini key in Providers" button needs to jump SettingsModal to
 * the Providers tab; since VoiceTab and SettingsModal don't otherwise share
 * state, a tiny store is simpler than threading a callback prop through the
 * tab-rendering switch.
 *
 * `requested` is consumed once: SettingsModal reads it in an effect and
 * clears it back to null, so re-opening Settings later doesn't jump tabs on
 * its own.
 */
export type SettingsTabId =
  | 'general'
  | 'providers'
  | 'persona'
  | 'theme'
  | 'voice'
  | 'toolbox'
  | 'packs'
  | 'usage'
  | 'stop';

interface SettingsTabStore {
  requested: SettingsTabId | null;
  /**
   * True right after `requestTab` is called from somewhere that might be
   * showing this outside an already-open Settings modal (the mic tier
   * banner). Sidebar watches this to open the modal itself; SettingsModal
   * being open already just switches tabs, same as before.
   */
  openRequested: boolean;
  requestTab: (tab: SettingsTabId) => void;
  clearRequest: () => void;
  clearOpenRequest: () => void;
}

export const useSettingsTabStore = create<SettingsTabStore>((set) => ({
  requested: null,
  openRequested: false,
  requestTab: (tab) => set({ requested: tab, openRequested: true }),
  clearRequest: () => set({ requested: null }),
  clearOpenRequest: () => set({ openRequested: false }),
}));
