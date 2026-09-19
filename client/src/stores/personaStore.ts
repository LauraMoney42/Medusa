import { create } from 'zustand';
import * as api from '../api';

/**
 * Shared persona display name, so the chat view's sender label stays in sync
 * with whatever is set in Settings > Persona without every consumer having to
 * fetch it itself.
 *
 * This is intentionally just the name (not the full Persona object): the
 * chat view only ever needs "what do we call the assistant", and keeping the
 * store narrow avoids re-rendering message bubbles when unrelated persona
 * fields (avatar, personality prose) change.
 */
const DEFAULT_NAME = 'Medusa';

interface PersonaState {
  /** Assistant display name, defaulting to "Medusa" until loaded or when unset. */
  name: string;
  loaded: boolean;
  refresh: () => Promise<void>;
  setName: (name: string) => void;
}

export const usePersonaStore = create<PersonaState>((set) => ({
  name: DEFAULT_NAME,
  loaded: false,
  refresh: async () => {
    try {
      const persona = await api.fetchPersona();
      set({ name: persona.name?.trim() || DEFAULT_NAME, loaded: true });
    } catch {
      // Leave the default name in place if the fetch fails (e.g. offline).
      set({ loaded: true });
    }
  },
  setName: (name) => set({ name: name.trim() || DEFAULT_NAME }),
}));
