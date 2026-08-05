import { create } from 'zustand';

/**
 * Shared text-to-speech preferences (persisted to localStorage), so the header
 * speaker toggle and the Settings voice controls stay in sync.
 */
function ls(key: string, def: string): string {
  try {
    return localStorage.getItem(key) ?? def;
  } catch {
    return def;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota/unavailable */
  }
}

interface TtsState {
  /** Auto-speak replies aloud. */
  speak: boolean;
  /** Selected voice id (backend-specific, e.g. Kokoro 'af_heart'). */
  voice: string;
  /** Playback speed multiplier (0.5–2.0). */
  speed: number;
  setSpeak: (v: boolean) => void;
  setVoice: (v: string) => void;
  setSpeed: (v: number) => void;
}

export const useTtsStore = create<TtsState>((set) => ({
  speak: ls('medusa-speak', '0') === '1',
  voice: ls('medusa-tts-voice', 'af_heart'),
  speed: Number(ls('medusa-tts-speed', '1')) || 1,
  setSpeak: (v) => { save('medusa-speak', v ? '1' : '0'); set({ speak: v }); },
  setVoice: (v) => { save('medusa-tts-voice', v); set({ voice: v }); },
  setSpeed: (v) => { save('medusa-tts-speed', String(v)); set({ speed: v }); },
}));
