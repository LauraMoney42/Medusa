import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from '../../socket';
import { useVoiceStore, type VoiceMode } from '../../stores/voiceStore';
import { MicCapture } from '../../lib/voice/micCapture';
import { GaplessAudioQueue } from '../../lib/voice/audioScheduler';
import { onAudioChunk, onStopAudio } from '../../lib/voice/voiceBus';
import type { VoiceAudioChunkPayload } from '../../types/voice';

interface VoiceBarProps {
  sessionId: string;
  /** The text input is empty and unfocused: gates the hold-Space shortcut. */
  inputEmpty?: boolean;
}

const STATE_LABEL: Record<string, string> = {
  idle: '',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

const MODES: { id: VoiceMode; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'push-to-talk', label: 'Push to talk' },
  { id: 'always-on', label: 'Always on' },
];

/** data: URL or base64 string -> ArrayBuffer, for `voice:audio-chunk` payloads sent as base64. */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Replaces the single mic button when voice mode is on (spec section 4).
 * Mode toggle, live waveform, state label, mute, interrupt. Mic capture and
 * TTS playback are wired here since both need a real AudioContext; the
 * cross-cutting state (mode/state/partial/mute) lives in stores/voiceStore.ts
 * so other components (Settings, ChatView) can read it without owning audio.
 */
export default function VoiceBar({ sessionId, inputEmpty = true }: VoiceBarProps) {
  const mode = useVoiceStore((s) => s.mode);
  const setMode = useVoiceStore((s) => s.setMode);
  const loopState = useVoiceStore((s) => s.state);
  const setLoopState = useVoiceStore((s) => s.setState);
  const partialTranscript = useVoiceStore((s) => s.partialTranscript);
  const speakerMuted = useVoiceStore((s) => s.speakerMuted);
  const setSpeakerMuted = useVoiceStore((s) => s.setSpeakerMuted);
  const echoGuardEnabled = useVoiceStore((s) => s.echoGuardEnabled);
  const echoGuardDuckFactor = useVoiceStore((s) => s.echoGuardDuckFactor);
  const lastLatency = useVoiceStore((s) => s.lastLatency);
  const active = useVoiceStore((s) => s.active);
  const setActive = useVoiceStore((s) => s.setActive);
  const reset = useVoiceStore((s) => s.reset);

  const micRef = useRef<MicCapture | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const schedulerRef = useRef<GaplessAudioQueue | null>(null);
  const holdingRef = useRef(false);
  const [held, setHeld] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const ensurePlaybackContext = useCallback(() => {
    if (!playbackCtxRef.current) {
      const ctx = new AudioContext();
      playbackCtxRef.current = ctx;
      schedulerRef.current = new GaplessAudioQueue(ctx);
      schedulerRef.current.onDrain = () => {
        if (useVoiceStore.getState().state === 'speaking') setLoopState('listening');
      };
    } else if (playbackCtxRef.current.state === 'suspended') {
      void playbackCtxRef.current.resume();
    }
    return { ctx: playbackCtxRef.current!, scheduler: schedulerRef.current! };
  }, [setLoopState]);

  // Play/skip incoming TTS chunks. Subscribed for the VoiceBar's whole
  // lifetime (not gated on mode) so a chunk that arrives right as the user
  // flips modes isn't dropped mid-utterance.
  useEffect(() => {
    const offChunk = onAudioChunk((payload: VoiceAudioChunkPayload) => {
      if (payload.sessionId !== sessionId) return;
      const { ctx, scheduler } = ensurePlaybackContext();
      scheduler.setMuted(speakerMuted);
      const buf =
        typeof payload.data === 'string' ? base64ToArrayBuffer(payload.data) : payload.data;
      ctx
        .decodeAudioData(buf.slice(0))
        .then((decoded) => {
          scheduler.enqueue(payload.seq, decoded);
        })
        .catch((err) => console.error('[voice] failed to decode audio chunk:', err));
    });
    const offStop = onStopAudio((payload) => {
      if (payload.sessionId !== sessionId) return;
      schedulerRef.current?.stopAll();
    });
    return () => {
      offChunk();
      offStop();
    };
  }, [sessionId, ensurePlaybackContext, speakerMuted]);

  useEffect(() => {
    schedulerRef.current?.setMuted(speakerMuted);
  }, [speakerMuted]);

  // Echo guard: duck the sent mic level while the assistant is speaking.
  useEffect(() => {
    const factor = loopState === 'speaking' && echoGuardEnabled ? echoGuardDuckFactor : 1;
    micRef.current?.setSentGain(factor);
  }, [loopState, echoGuardEnabled, echoGuardDuckFactor]);

  const sendFrame = useCallback(
    (pcm16: ArrayBuffer) => {
      getSocket().emit('voice:audio', { sessionId, pcm16 });
    },
    [sessionId],
  );

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = micRef.current?.analyserNode;
    if (!canvas || !analyser) {
      rafRef.current = requestAnimationFrame(drawWaveform);
      return;
    }
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = loopState === 'speaking' ? '#c084fc' : 'var(--accent, #4aba6a)';
    const barCount = 24;
    const step = Math.floor(data.length / barCount) || 1;
    const barWidth = w / barCount;
    for (let i = 0; i < barCount; i++) {
      const v = Math.abs((data[i * step] - 128) / 128);
      const barHeight = Math.max(2, v * h);
      ctx2d.fillRect(i * barWidth + 1, (h - barHeight) / 2, Math.max(1, barWidth - 2), barHeight);
    }
    rafRef.current = requestAnimationFrame(drawWaveform);
  }, [loopState]);

  useEffect(() => {
    if (mode === 'off') return;
    rafRef.current = requestAnimationFrame(drawWaveform);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [mode, drawWaveform]);

  const startCapture = useCallback(async () => {
    if (micRef.current) return;
    const capture = new MicCapture({
      onFrame: sendFrame,
      onError: (err) => console.error('[voice] mic capture failed:', err),
    });
    micRef.current = capture;
    await capture.start();
  }, [sendFrame]);

  const stopCapture = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
  }, []);

  const handleInterrupt = useCallback(() => {
    getSocket().emit('voice:interrupt', { sessionId });
    schedulerRef.current?.stopAll();
    reset();
  }, [sessionId, reset]);

  const handleModeChange = useCallback(
    async (next: VoiceMode) => {
      // A user gesture, so this is a safe place to unlock both AudioContexts.
      ensurePlaybackContext();
      if (mode === next) return;
      if (mode === 'always-on') {
        stopCapture();
        getSocket().emit('voice:stop', { sessionId });
        setActive(false);
      }
      setMode(next);
      if (next === 'off') {
        stopCapture();
        if (active) getSocket().emit('voice:stop', { sessionId });
        setActive(false);
        reset();
        return;
      }
      if (next === 'always-on') {
        try {
          await startCapture();
          getSocket().emit('voice:start', { sessionId, mode: 'always-on' });
          setActive(true);
          setLoopState('listening');
        } catch (err) {
          console.error('[voice] could not start always-on capture:', err);
          setMode('off');
        }
      }
      // push-to-talk starts capture lazily on hold.
    },
    [mode, sessionId, active, setActive, setMode, startCapture, stopCapture, reset, setLoopState, ensurePlaybackContext],
  );

  const beginHold = useCallback(async () => {
    if (mode !== 'push-to-talk' || holdingRef.current) return;
    holdingRef.current = true;
    setHeld(true);
    ensurePlaybackContext();
    try {
      await startCapture();
      getSocket().emit('voice:start', { sessionId, mode: 'push-to-talk' });
      setActive(true);
      setLoopState('listening');
    } catch (err) {
      console.error('[voice] could not start push-to-talk capture:', err);
      holdingRef.current = false;
      setHeld(false);
    }
  }, [mode, sessionId, setActive, setLoopState, startCapture, ensurePlaybackContext]);

  const endHold = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHeld(false);
    stopCapture();
    getSocket().emit('voice:stop', { sessionId });
    setActive(false);
  }, [sessionId, setActive, stopCapture]);

  // Keyboard: hold Space to talk (only when push-to-talk, input empty, and
  // focus isn't on an editable element); Esc always interrupts.
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && mode !== 'off') {
        handleInterrupt();
        return;
      }
      if (
        e.code === 'Space' &&
        mode === 'push-to-talk' &&
        inputEmpty &&
        !isEditableTarget(e.target) &&
        !e.repeat
      ) {
        e.preventDefault();
        void beginHold();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && mode === 'push-to-talk') {
        e.preventDefault();
        endHold();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [mode, inputEmpty, beginHold, endHold, handleInterrupt]);

  useEffect(() => () => {
    stopCapture();
    schedulerRef.current?.stopAll();
    void playbackCtxRef.current?.close().catch(() => {});
  }, [stopCapture]);

  const label = STATE_LABEL[loopState] ?? '';

  return (
    <div style={styles.bar} data-voice-mode={mode} data-voice-state={loopState}>
      <div style={styles.modeToggle} role="tablist" aria-label="Voice mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            onClick={() => void handleModeChange(m.id)}
            style={{ ...styles.modeBtn, ...(mode === m.id ? styles.modeBtnActive : {}) }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode !== 'off' && (
        <>
          {mode === 'push-to-talk' && (
            <button
              style={{ ...styles.pttBtn, ...(held ? styles.pttBtnHeld : {}) }}
              onMouseDown={() => void beginHold()}
              onMouseUp={endHold}
              onMouseLeave={() => holdingRef.current && endHold()}
              onTouchStart={() => void beginHold()}
              onTouchEnd={endHold}
              title="Hold to talk (or hold Space)"
            >
              Hold to talk
            </button>
          )}

          <canvas ref={canvasRef} width={140} height={28} style={styles.waveform} aria-hidden />

          <span style={styles.stateLabel}>{label}</span>

          {partialTranscript && (
            <span style={styles.partial} title={partialTranscript}>
              {partialTranscript}
            </span>
          )}

          <button
            onClick={() => setSpeakerMuted(!speakerMuted)}
            title={speakerMuted ? 'Unmute speaker' : 'Mute speaker'}
            style={{ ...styles.iconBtn, color: speakerMuted ? 'var(--danger)' : 'var(--text-secondary)' }}
          >
            {speakerMuted ? '🔇' : '🔊'}
          </button>

          <button
            onClick={handleInterrupt}
            title="Interrupt (Esc)"
            disabled={loopState !== 'speaking' && loopState !== 'thinking'}
            style={styles.interruptBtn}
          >
            Interrupt
          </button>

          {lastLatency?.totalMs != null && (
            <span style={styles.latency} title="Last turn latency">
              {lastLatency.totalMs}ms
            </span>
          )}
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 8px',
    flexWrap: 'wrap',
  },
  modeToggle: {
    display: 'flex',
    gap: 2,
    background: '#1c1c1e',
    borderRadius: 8,
    padding: 2,
  },
  modeBtn: {
    padding: '3px 8px',
    fontSize: 11,
    color: 'var(--text-muted)',
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  modeBtnActive: {
    background: 'var(--accent)',
    color: '#fff',
  },
  pttBtn: {
    padding: '4px 10px',
    fontSize: 11,
    color: 'var(--text-primary)',
    background: '#2a2a2c',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 6,
    cursor: 'pointer',
    userSelect: 'none',
  },
  pttBtnHeld: {
    background: 'var(--danger)',
    color: '#fff',
  },
  waveform: {
    width: 140,
    height: 28,
    borderRadius: 4,
    background: '#111',
  },
  stateLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    minWidth: 56,
  },
  partial: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
    maxWidth: 220,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  iconBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
  },
  interruptBtn: {
    padding: '3px 8px',
    fontSize: 11,
    color: 'var(--text-primary)',
    background: '#2a2a2c',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 6,
    cursor: 'pointer',
  },
  latency: {
    fontSize: 10,
    color: 'var(--text-muted)',
  },
};
