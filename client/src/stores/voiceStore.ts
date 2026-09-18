import { create } from 'zustand';

/**
 * Voice loop UI state (S14-C, spec section 4/7). This store holds only
 * plain, serializable state. The AudioContext, MicCapture and
 * GaplessAudioQueue instances that actually move bytes live in VoiceBar
 * (React-owned refs), since Web Audio objects don't belong in zustand.
 *
 * Settings that should survive a reload (mode, mute, echo guard) persist to
 * localStorage the same way stores/ttsStore.ts does; VAD sensitivity,
 * silence timeout and interrupt behavior are per-account and live on the
 * server (Settings > Voice, see components/Settings/VoiceTab.tsx).
 */

export type VoiceMode = 'off' | 'push-to-talk' | 'always-on';
export type VoiceLoopState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface VoiceLatency {
  sttMs?: number;
  firstTokenMs?: number;
  firstAudioMs?: number;
  totalMs?: number;
}

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

interface VoiceState {
  mode: VoiceMode;
  state: VoiceLoopState;
  /** Live partial transcript while listening; cleared once a final arrives. */
  partialTranscript: string;
  speakerMuted: boolean;
  /** Echo guard: duck (not mute) the sent mic level while speaking. */
  echoGuardEnabled: boolean;
  /** 0..1 gain applied to the sent mic signal while speaking, when enabled. */
  echoGuardDuckFactor: number;
  /** Latest voice:latency reading, for the VoiceBar and a badge in Activity. */
  lastLatency: VoiceLatency | null;
  /** True while the socket has an active voice:start for this session. */
  active: boolean;
  /** 0..1 input level for the waveform, updated at animation-frame rate. */
  inputLevel: number;
}

interface VoiceActions {
  setMode: (mode: VoiceMode) => void;
  setState: (state: VoiceLoopState) => void;
  setPartialTranscript: (text: string) => void;
  setSpeakerMuted: (muted: boolean) => void;
  setEchoGuardEnabled: (enabled: boolean) => void;
  setEchoGuardDuckFactor: (factor: number) => void;
  setLastLatency: (latency: VoiceLatency) => void;
  setActive: (active: boolean) => void;
  setInputLevel: (level: number) => void;
  /** voice:stop-audio and interrupts both return the loop to a clean slate. */
  reset: () => void;
}

export const useVoiceStore = create<VoiceState & VoiceActions>((set) => ({
  mode: (ls('medusa-voice-mode', 'off') as VoiceMode) || 'off',
  state: 'idle',
  partialTranscript: '',
  speakerMuted: ls('medusa-voice-speaker-muted', '0') === '1',
  echoGuardEnabled: ls('medusa-voice-echo-guard', '1') === '1',
  echoGuardDuckFactor: Number(ls('medusa-voice-echo-duck', '0.35')) || 0.35,
  lastLatency: null,
  active: false,
  inputLevel: 0,

  setMode: (mode) => {
    save('medusa-voice-mode', mode);
    set({ mode });
  },
  setState: (state) => set({ state }),
  setPartialTranscript: (partialTranscript) => set({ partialTranscript }),
  setSpeakerMuted: (speakerMuted) => {
    save('medusa-voice-speaker-muted', speakerMuted ? '1' : '0');
    set({ speakerMuted });
  },
  setEchoGuardEnabled: (echoGuardEnabled) => {
    save('medusa-voice-echo-guard', echoGuardEnabled ? '1' : '0');
    set({ echoGuardEnabled });
  },
  setEchoGuardDuckFactor: (echoGuardDuckFactor) => {
    save('medusa-voice-echo-duck', String(echoGuardDuckFactor));
    set({ echoGuardDuckFactor });
  },
  setLastLatency: (lastLatency) => set({ lastLatency }),
  setActive: (active) => set({ active }),
  setInputLevel: (inputLevel) => set({ inputLevel }),
  reset: () => set({ state: 'idle', partialTranscript: '', inputLevel: 0 }),
}));
