import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from '../../socket';
import { useVoiceStore } from '../../stores/voiceStore';
import { MicCapture } from '../../lib/voice/micCapture';
import { GaplessAudioQueue } from '../../lib/voice/audioScheduler';
import type { EchoGate } from '../../lib/voice/echoGate';
import { micGateFor, reportsLocalBargeIn, sentGainFor } from '../../lib/voice/micGating';
import { onAudioChunk, onStopAudio, onSpeakingStart } from '../../lib/voice/voiceBus';
import type { VoiceAudioChunkPayload } from '../../types/voice';
import { fetchVoiceSettings } from '../../api';
import VoiceTierBadge from './VoiceTierBadge';

/**
 * Settings > Voice's "VAD sensitivity" is a 0..1 dial (spec section 4); the
 * server's `Vad` wants an RMS energy threshold in int16 units, where a LOWER
 * number is MORE sensitive (VAD_DEFAULTS is 500). Map the dial linearly over
 * a band a laptop mic can actually resolve: 1500 (least sensitive) at 0 down
 * to 100 (most sensitive) at 1.
 */
function sensitivityToEnergyThreshold(sensitivity: number): number {
  const clamped = Math.min(1, Math.max(0, sensitivity));
  return Math.round(1500 - clamped * 1400);
}

/** data: URL or base64 string -> ArrayBuffer, for `voice:audio-chunk` payloads sent as base64. */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const LOCAL_MODE_KEY = 'medusa-voice-mode';
const LONG_PRESS_MS = 600;

interface VoiceMicButtonProps {
  sessionId: string;
  /** The text input is empty and unfocused: gates the hold-Space shortcut. */
  inputEmpty?: boolean;
}

/**
 * A single toggle mic button that sits at the far right of the text input,
 * immediately left of send (owner's request, replaces the old VoiceBar strip
 * and the legacy dictate-only MicButton). Click turns always-on voice on or
 * off; while the assistant is speaking, a click interrupts instead, and a
 * long-press always stops the loop outright.
 *
 * This owns the same audio wiring VoiceBar used to (mic capture, playback
 * AudioContext, gapless TTS scheduling) since both need a real AudioContext;
 * the cross-cutting state (mode/state/partial/mute) still lives in
 * stores/voiceStore.ts so other components (Settings, ChatView) can read it.
 */
export default function VoiceMicButton({ sessionId, inputEmpty = true }: VoiceMicButtonProps) {
  const mode = useVoiceStore((s) => s.mode);
  const setMode = useVoiceStore((s) => s.setMode);
  const loopState = useVoiceStore((s) => s.state);
  const setLoopState = useVoiceStore((s) => s.setState);
  const partialTranscript = useVoiceStore((s) => s.partialTranscript);
  const speakerMuted = useVoiceStore((s) => s.speakerMuted);
  const echoGuardEnabled = useVoiceStore((s) => s.echoGuardEnabled);
  const echoGuardDuckFactor = useVoiceStore((s) => s.echoGuardDuckFactor);
  const bargeInEnergyThreshold = useVoiceStore((s) => s.bargeInEnergyThreshold);
  const bargeInMinSpeechMs = useVoiceStore((s) => s.bargeInMinSpeechMs);
  // Which tier owns turn-taking. In "live" the provider's own VAD does, so
  // nothing here may gate or duck the outgoing mic (see lib/voice/micGating.ts).
  const tier = useVoiceStore((s) => s.tier);
  const active = useVoiceStore((s) => s.active);
  const setActive = useVoiceStore((s) => s.setActive);
  const reset = useVoiceStore((s) => s.reset);

  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState(false); // push-to-talk (Settings default mode only)

  const micRef = useRef<MicCapture | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const schedulerRef = useRef<GaplessAudioQueue | null>(null);
  const holdingRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressFiredRef = useRef(false);
  const startedFromPersistedRef = useRef(false);
  // Settings > Voice's loop gains (silence timeout, VAD sensitivity), fetched
  // once and sent on every `voice:start` so a saved change actually reaches
  // the running VoiceSession instead of only living in voice.json.
  const vadOptionsRef = useRef<{ silenceMs?: number; energyThreshold?: number } | undefined>(
    undefined,
  );
  // Settings > Voice > Advanced's barge-in thresholds, mirrored into a ref
  // so the voice:start call sites below (some in effects with narrow dep
  // arrays) always send the current value without needing to re-run.
  const bargeInOptionsRef = useRef({ bargeInEnergyThreshold, bargeInMinSpeechMs });
  useEffect(() => {
    bargeInOptionsRef.current = { bargeInEnergyThreshold, bargeInMinSpeechMs };
  }, [bargeInEnergyThreshold, bargeInMinSpeechMs]);

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

  // Echo gate, pipeline tier only: while she speaks, only sustained loud
  // frames leave this machine, because the server's own Whisper/VAD loop would
  // otherwise transcribe her speaker leakage as a user turn. `micGateFor`
  // returns null in live tier, where Gemini's VAD needs the continuous stream
  // and a closed gate left it deaf to the user's next turn.
  const echoGateRef = useRef<EchoGate | null>(null);
  // Mirrored so `sendFrame` (captured once by MicCapture) always sees the
  // current tier without the capture having to be torn down and restarted.
  const tierRef = useRef(tier);
  useEffect(() => {
    tierRef.current = tier;
  }, [tier]);
  useEffect(() => {
    echoGateRef.current = micGateFor({
      tier,
      echoGuardEnabled,
      echoGuardDuckFactor,
      bargeInEnergyThreshold,
      bargeInMinSpeechMs,
    });
    // A gate created mid-turn has to be told the turn is already in progress,
    // or it would sit wide open for the rest of it.
    echoGateRef.current?.setSpeaking(useVoiceStore.getState().state === 'speaking');
  }, [tier, echoGuardEnabled, bargeInEnergyThreshold, bargeInMinSpeechMs, echoGuardDuckFactor]);
  useEffect(() => {
    echoGateRef.current?.setSpeaking(loopState === 'speaking');
  }, [loopState]);

  const sendFrame = useCallback(
    (pcm16: ArrayBuffer) => {
      const socket = getSocket();
      const gate = echoGateRef.current;
      // No gate (live tier, or the echo guard switched off): every captured
      // frame goes out, for the whole life of the session, whatever the loop
      // state is. This is the only way the provider's own VAD can find the
      // start of the user's next turn.
      if (!gate) {
        socket.emit('voice:audio', { sessionId, pcm16 });
        return;
      }
      const wasOpen = gate.isOpen;
      const frames = gate.accept(new Int16Array(pcm16));
      // Local barge-in, pipeline tier only. The gate opening while she speaks
      // means sustained, above-the-floor speech from the user, not playback
      // leakage, and the local loop has nothing else watching for it.
      if (!wasOpen && gate.isOpen && reportsLocalBargeIn(tierRef.current)) {
        schedulerRef.current?.stopAll(schedulerRef.current.activeTurnId ?? undefined);
        socket.emit('voice:interrupt', { sessionId });
      }
      for (const frame of frames) {
        socket.emit('voice:audio', { sessionId, pcm16: frame.buffer });
      }
    },
    [sessionId],
  );

  const startCapture = useCallback(async () => {
    if (micRef.current) return;
    const capture = new MicCapture({
      onFrame: sendFrame,
      onError: (err) => {
        console.error('[voice] mic capture failed:', err);
        setError('Mic capture failed');
      },
    });
    micRef.current = capture;
    await capture.start();
  }, [sendFrame]);

  const stopCapture = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
  }, []);

  // Play/skip incoming TTS chunks. Subscribed for the button's whole
  // lifetime (not gated on mode) so a chunk that arrives right as the user
  // flips modes isn't dropped mid-utterance.
  //
  // Single speaker ownership (turnId): `voice:speaking-start` tells the
  // scheduler a new turn has begun BEFORE that turn's first chunk arrives,
  // so it can drop late audio from whatever turn it was previously playing
  // even when nothing triggered an explicit `voice:stop-audio` (the normal,
  // non-interrupted end of a turn never emits one). Each chunk also carries
  // its own turnId as a second, per-chunk check.
  useEffect(() => {
    const offSpeakingStart = onSpeakingStart((payload) => {
      if (payload.sessionId !== sessionId || !payload.turnId) return;
      const { scheduler } = ensurePlaybackContext();
      scheduler.beginTurn(payload.turnId);
    });
    const offChunk = onAudioChunk((payload: VoiceAudioChunkPayload) => {
      if (payload.sessionId !== sessionId) return;
      const { ctx, scheduler } = ensurePlaybackContext();
      scheduler.setMuted(speakerMuted);
      const buf =
        typeof payload.data === 'string' ? base64ToArrayBuffer(payload.data) : payload.data;
      ctx
        .decodeAudioData(buf.slice(0))
        .then((decoded) => {
          scheduler.enqueue(payload.seq, decoded, payload.turnId);
        })
        .catch((err) => console.error('[voice] failed to decode audio chunk:', err));
    });
    const offStop = onStopAudio((payload) => {
      if (payload.sessionId !== sessionId) return;
      // Naming the stopped turn lets the scheduler refuse its tail: a chunk
      // still inside decodeAudioData when the stop lands would otherwise be
      // scheduled into the next turn and played over the new reply.
      schedulerRef.current?.stopAll(payload.turnId);
    });
    return () => {
      offSpeakingStart();
      offChunk();
      offStop();
    };
  }, [sessionId, ensurePlaybackContext, speakerMuted]);

  useEffect(() => {
    schedulerRef.current?.setMuted(speakerMuted);
  }, [speakerMuted]);

  // Echo guard, pipeline tier only: duck the sent mic level from
  // speaking-start until 400 ms after speaking-end, not just while
  // `loopState === 'speaking'`. Her echo lingers in the room (and in the
  // speaker's own decay) for a beat after playback stops, so releasing the duck
  // the instant the state flips back to "listening" left a short window where a
  // full-gain mic could still trip the barge-in detector on nothing but room
  // echo.
  //
  // In live tier `sentGainFor` is always 1: the outgoing mic is never touched,
  // because the provider's VAD is listening to it for the user's next turn even
  // while she is mid-reply. Only the SPEAKER side is ever quietened there
  // (`speakerMuted` -> the scheduler).
  const duckReleaseTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (duckReleaseTimerRef.current != null) {
      window.clearTimeout(duckReleaseTimerRef.current);
      duckReleaseTimerRef.current = null;
    }
    const guard = { tier, echoGuardEnabled, echoGuardDuckFactor };
    if (loopState === 'speaking') {
      micRef.current?.setSentGain(sentGainFor(guard, true));
      return;
    }
    if (sentGainFor(guard, true) === 1) {
      // Nothing was ducked on the way in, so there is nothing to release.
      micRef.current?.setSentGain(1);
      return;
    }
    // Just left "speaking": hold the duck for the same 400 ms grace window
    // the server's barge-in detector stays armed for.
    duckReleaseTimerRef.current = window.setTimeout(() => {
      micRef.current?.setSentGain(1);
      duckReleaseTimerRef.current = null;
    }, 400);
    return () => {
      if (duckReleaseTimerRef.current != null) {
        window.clearTimeout(duckReleaseTimerRef.current);
        duckReleaseTimerRef.current = null;
      }
    };
  }, [loopState, tier, echoGuardEnabled, echoGuardDuckFactor]);

  // Fetch the account's saved VAD gains for voice:start, and (only when this
  // browser has never chosen a mode locally) seed the toggle from Settings >
  // Voice's "default mode" - the only way push-to-talk stays reachable now
  // that the primary control is a plain on/off toggle.
  useEffect(() => {
    let cancelled = false;
    fetchVoiceSettings()
      .then((v) => {
        if (cancelled) return;
        vadOptionsRef.current = {
          silenceMs: v.silenceTimeoutMs,
          energyThreshold:
            v.vadSensitivity != null ? sensitivityToEnergyThreshold(v.vadSensitivity) : undefined,
        };
        let hasLocalChoice = true;
        try {
          hasLocalChoice = localStorage.getItem(LOCAL_MODE_KEY) != null;
        } catch {
          hasLocalChoice = true;
        }
        if (!hasLocalChoice && v.voiceMode && v.voiceMode !== 'off') {
          setMode(v.voiceMode);
        }
      })
      .catch((err) => console.error('[voice] failed to load voice settings:', err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist-on-reload (spec requirement): if the toggle was left on
  // (always-on) before a reload, re-request the mic and resume automatically.
  useEffect(() => {
    if (mode !== 'always-on' || startedFromPersistedRef.current || active) return;
    startedFromPersistedRef.current = true;
    (async () => {
      ensurePlaybackContext();
      try {
        await startCapture();
        getSocket().emit('voice:start', { sessionId, mode: 'always-on', vad: vadOptionsRef.current, bargeIn: bargeInOptionsRef.current });
        setActive(true);
        setLoopState('listening');
        setError(null);
      } catch (err) {
        console.error('[voice] could not resume always-on capture after reload:', err);
        setError('Mic permission needed');
        setMode('off');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, sessionId]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = micRef.current?.analyserNode;
    if (!canvas) {
      rafRef.current = requestAnimationFrame(drawWaveform);
      return;
    }
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);
    if (!analyser) {
      rafRef.current = requestAnimationFrame(drawWaveform);
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    ctx2d.fillStyle = loopState === 'speaking' ? '#4aa8ff' : '#4aba6a';
    const barCount = 6;
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

  /** Turns the loop fully off, whatever state it was in. */
  const turnOff = useCallback(() => {
    stopCapture();
    if (active) getSocket().emit('voice:stop', { sessionId });
    setActive(false);
    setMode('off');
    reset();
    setError(null);
  }, [sessionId, active, setActive, setMode, reset, stopCapture]);

  const turnOn = useCallback(async () => {
    ensurePlaybackContext(); // a user gesture, so safe to unlock the AudioContext here
    try {
      await startCapture();
      getSocket().emit('voice:start', { sessionId, mode: 'always-on', vad: vadOptionsRef.current, bargeIn: bargeInOptionsRef.current });
      setMode('always-on');
      setActive(true);
      setLoopState('listening');
      setError(null);
    } catch (err) {
      console.error('[voice] could not start always-on capture:', err);
      setError('Could not access the microphone');
      setMode('off');
    }
  }, [sessionId, setActive, setMode, setLoopState, startCapture, ensurePlaybackContext]);

  /** While speaking, a click interrupts and keeps listening rather than stopping. */
  const interrupt = useCallback(() => {
    getSocket().emit('voice:interrupt', { sessionId });
    schedulerRef.current?.stopAll(schedulerRef.current.activeTurnId ?? undefined);
    useVoiceStore.getState().setPartialTranscript('');
    setLoopState('listening');
  }, [sessionId, setLoopState]);

  const handleShortClick = useCallback(() => {
    if (mode === 'off') {
      void turnOn();
    } else if (loopState === 'speaking') {
      interrupt();
    } else {
      turnOff();
    }
  }, [mode, loopState, turnOn, interrupt, turnOff]);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handlePointerDown = useCallback(() => {
    longPressFiredRef.current = false;
    clearLongPressTimer();
    if (mode !== 'off') {
      longPressTimerRef.current = window.setTimeout(() => {
        longPressFiredRef.current = true;
        turnOff();
      }, LONG_PRESS_MS);
    }
  }, [mode, turnOff, clearLongPressTimer]);

  const handlePointerUp = useCallback(() => {
    clearLongPressTimer();
    if (!longPressFiredRef.current) handleShortClick();
  }, [clearLongPressTimer, handleShortClick]);

  const handlePointerLeave = useCallback(() => {
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  // Push-to-talk hold, reachable only via Settings > Voice's "default mode".
  const beginHold = useCallback(async () => {
    if (mode !== 'push-to-talk' || holdingRef.current) return;
    holdingRef.current = true;
    setHeld(true);
    ensurePlaybackContext();
    try {
      await startCapture();
      getSocket().emit('voice:start', { sessionId, mode: 'push-to-talk', vad: vadOptionsRef.current, bargeIn: bargeInOptionsRef.current });
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
  // focus isn't on an editable element); Esc always interrupts/stops.
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && mode !== 'off') {
        if (loopState === 'speaking') interrupt();
        else turnOff();
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
  }, [mode, loopState, inputEmpty, beginHold, endHold, interrupt, turnOff]);

  useEffect(
    () => () => {
      clearLongPressTimer();
      stopCapture();
      schedulerRef.current?.stopAll();
      void playbackCtxRef.current?.close().catch(() => {});
    },
    [stopCapture, clearLongPressTimer],
  );

  const isOn = mode !== 'off' || held;
  const showWaveform = isOn && (loopState === 'listening' || loopState === 'speaking');

  const color = error
    ? 'var(--danger)'
    : loopState === 'speaking'
      ? '#4aa8ff'
      : loopState === 'thinking'
        ? '#f5a623'
        : loopState === 'listening'
          ? 'var(--accent, #4aba6a)'
          : 'var(--text-muted)';

  const tooltip = error
    ? error
    : mode === 'off'
      ? 'Click to start voice'
      : loopState === 'speaking'
        ? 'Click to interrupt - hold to stop voice'
        : loopState === 'thinking'
          ? 'Thinking - hold to stop voice'
          : 'Click again to stop voice';

  // The tier badge is a sibling of the button, not a child: a <button> may not
  // contain another interactive-looking element, and the surrounding row is a
  // flex container, so a fragment lands it right beside the mic.
  return (
    <>
    <VoiceTierBadge />
    <button
      type="button"
      onMouseDown={handlePointerDown}
      onMouseUp={handlePointerUp}
      onMouseLeave={handlePointerLeave}
      onTouchStart={handlePointerDown}
      onTouchEnd={handlePointerUp}
      title={tooltip}
      aria-pressed={mode !== 'off'}
      aria-label={mode === 'off' ? 'Start voice' : 'Voice controls, click to stop or interrupt'}
      data-voice-mode={mode}
      data-voice-state={loopState}
      className={loopState === 'listening' ? 'medusa-mic-listening' : undefined}
      style={{
        ...styles.btn,
        color,
        width: showWaveform ? 56 : 32,
      }}
    >
      {showWaveform && (
        <canvas ref={canvasRef} width={24} height={16} style={styles.waveform} aria-hidden />
      )}
      {loopState === 'speaking' ? (
        <span className="medusa-mic-bars" style={styles.bars} aria-hidden>
          <span style={{ ...styles.bar, background: color }} />
          <span style={{ ...styles.bar, background: color }} />
          <span style={{ ...styles.bar, background: color }} />
        </span>
      ) : (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
      {partialTranscript && loopState === 'listening' && (
        <span style={{ display: 'none' }}>{partialTranscript}</span>
      )}
    </button>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  btn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    height: 32,
    borderRadius: 8,
    background: 'transparent',
    border: 'none',
    flexShrink: 0,
    cursor: 'pointer',
    padding: '0 4px',
    transition: 'color 0.15s, width 0.15s',
  },
  waveform: {
    width: 24,
    height: 16,
    borderRadius: 3,
  },
  bars: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 2,
    height: 14,
  },
  bar: {
    display: 'block',
    width: 3,
    height: 14,
    borderRadius: 1.5,
    transformOrigin: 'bottom',
  },
};
