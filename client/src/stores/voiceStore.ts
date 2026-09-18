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
  /**
   * S16: how the turn was run. `warm` means the engine process was already
   * alive; `speculative` means the turn started on a stable partial rather
   * than on the final transcript. Both are absent on an older server.
   */
  warm?: boolean;
  speculative?: boolean;
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
  /**
   * Barge-in thresholds (Settings > Voice > Advanced), sent to the server
   * on `voice:start`. Only consulted while thinking/speaking; normal
   * listening still uses the plain VAD sensitivity dial.
   */
  bargeInEnergyThreshold: number;
  bargeInMinSpeechMs: number;
  /** Latest voice:latency reading, for the VoiceBar and a badge in Activity. */
  lastLatency: VoiceLatency | null;
  /** True while the socket has an active voice:start for this session. */
  active: boolean;
  /**
   * S17: which tier the server put this chat on. Null until `voice:tier`
   * arrives (an older server never sends it, and the badge stays hidden).
   */
  tier: 'live' | 'pipeline' | null;
  /** Why that tier, including how to move up for free. Shown as the tooltip. */
  tierReason: string | null;
  tierModel: string | null;
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
  setBargeInEnergyThreshold: (threshold: number) => void;
  setBargeInMinSpeechMs: (ms: number) => void;
  setLastLatency: (latency: VoiceLatency) => void;
  setActive: (active: boolean) => void;
  setTier: (tier: { tier: 'live' | 'pipeline'; reason?: string; model?: string | null }) => void;
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
  // 0.15 (not 0.35): laptop-speaker echo easily tripped the old, higher
  // duck level's leftover mic signal past the VAD gate. The barge-in
  // detector (server/src/voice/barge-in.ts) is the real fix for that, but a
  // lower duck factor gives it a quieter signal to work with.
  echoGuardDuckFactor: Number(ls('medusa-voice-echo-duck', '0.15')) || 0.15,
  bargeInEnergyThreshold: Number(ls('medusa-voice-bargein-energy', '2000')) || 2000,
  bargeInMinSpeechMs: Number(ls('medusa-voice-bargein-ms', '300')) || 300,
  lastLatency: null,
  active: false,
  tier: null,
  tierReason: null,
  tierModel: null,
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
  setBargeInEnergyThreshold: (bargeInEnergyThreshold) => {
    save('medusa-voice-bargein-energy', String(bargeInEnergyThreshold));
    set({ bargeInEnergyThreshold });
  },
  setBargeInMinSpeechMs: (bargeInMinSpeechMs) => {
    save('medusa-voice-bargein-ms', String(bargeInMinSpeechMs));
    set({ bargeInMinSpeechMs });
  },
  setLastLatency: (lastLatency) => set({ lastLatency }),
  setActive: (active) => set({ active }),
  setTier: ({ tier, reason, model }) =>
    set({ tier, tierReason: reason ?? null, tierModel: model ?? null }),
  setInputLevel: (inputLevel) => set({ inputLevel }),
  reset: () => set({ state: 'idle', partialTranscript: '', inputLevel: 0 }),
}));
