import { useState, useRef, useCallback, useEffect } from 'react';
import { transcribeAudio, fetchSttStatus } from '../../api';

interface MicButtonProps {
  /**
   * Called with the transcription so far. `isFinal` is false for interim
   * updates emitted while recording, true for the last result after stop.
   * `session` increments per recording so the consumer can tell dictations apart.
   */
  onTranscript: (text: string, isFinal: boolean, session: number) => void;
  disabled?: boolean;
  /** Small, chrome-less icon variant (no circular background) for compact toolbars. */
  compact?: boolean;
}

type MicState = 'idle' | 'recording' | 'transcribing';

// How often to re-transcribe the running audio for a live-ish preview.
const SLICE_MS = 1500;

/**
 * Push-to-dictate mic button with progressive (near-live) transcription.
 *
 * Records with MediaRecorder in short slices (works in Chrome and the packaged
 * macOS WKWebView, unlike the SpeechRecognition API). Every slice, it
 * re-transcribes the audio captured so far and emits an interim result, then a
 * final result on stop. Renders nothing unless the browser can record AND the
 * server reports a transcription backend is configured.
 */
export default function MicButton({ onTranscript, disabled, compact }: MicButtonProps) {
  const [state, setState] = useState<MicState>('idle');
  const [available, setAvailable] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const mimeRef = useRef<string>('audio/webm');
  const sessionRef = useRef(0);
  const inFlightRef = useRef(false); // a partial transcription is running
  const finalizingRef = useRef(false); // stop pressed — ignore further interims

  useEffect(() => {
    let cancelled = false;
    const canRecord =
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof window !== 'undefined' &&
      'MediaRecorder' in window;
    if (!canRecord) return;
    fetchSttStatus()
      .then((s) => { if (!cancelled) setAvailable(s.enabled); })
      .catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Re-transcribe everything recorded so far and emit an interim result.
  const transcribePartial = useCallback(async () => {
    if (inFlightRef.current || finalizingRef.current || chunksRef.current.length === 0) return;
    inFlightRef.current = true;
    const session = sessionRef.current;
    try {
      const blob = new Blob(chunksRef.current, { type: mimeRef.current });
      const { text } = await transcribeAudio(blob);
      if (text && !finalizingRef.current && session === sessionRef.current) {
        onTranscript(text, false, session);
      }
    } catch {
      // Interim failures (e.g. a not-yet-flushed audio frame) are non-fatal.
    } finally {
      inFlightRef.current = false;
    }
  }, [onTranscript]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      finalizingRef.current = false;
      sessionRef.current += 1;
      const session = sessionRef.current;

      // Chrome records webm/opus; Safari/WKWebView records mp4 — pick what's supported.
      const preferred = ['audio/webm', 'audio/mp4', 'audio/ogg'];
      const mimeType = preferred.find((t) => MediaRecorder.isTypeSupported(t));
      mimeRef.current = mimeType || 'audio/webm';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
        // Fire a live preview transcription (skipped if one is already running).
        if (!finalizingRef.current) void transcribePartial();
      };
      recorder.onstop = async () => {
        stopStream();
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        chunksRef.current = [];
        if (blob.size === 0) { setState('idle'); return; }
        setState('transcribing');
        try {
          const { text } = await transcribeAudio(blob);
          onTranscript(text, true, session);
        } catch (err) {
          console.error('Transcription failed:', err);
          alert(err instanceof Error ? err.message : 'Transcription failed');
        } finally {
          setState('idle');
        }
      };

      recorder.start(SLICE_MS); // emit a chunk every SLICE_MS for live updates
      setState('recording');
    } catch (err) {
      console.error('Mic access failed:', err);
      alert('Could not access the microphone. Check that mic permission is granted.');
      setState('idle');
      stopStream();
    }
  }, [onTranscript, stopStream, transcribePartial]);

  const stopRecording = useCallback(() => {
    finalizingRef.current = true; // ignore any in-flight interim results
    recorderRef.current?.stop();
  }, []);

  useEffect(() => () => stopStream(), [stopStream]);

  if (!available) return null;

  const handleClick = () => {
    if (disabled || state === 'transcribing') return;
    if (state === 'recording') stopRecording();
    else startRecording();
  };

  const iconSize = compact ? 13 : 18;

  return (
    <button
      onClick={handleClick}
      disabled={disabled || state === 'transcribing'}
      style={{
        ...(compact ? styles.btnCompact : styles.btn),
        ...(state === 'recording' ? (compact ? styles.recordingCompact : styles.recording) : {}),
      }}
      title={
        state === 'recording'
          ? 'Stop and transcribe'
          : state === 'transcribing'
            ? 'Transcribing…'
            : 'Dictate'
      }
    >
      {state === 'transcribing' ? (
        <svg width={iconSize} height={iconSize} viewBox="0 0 50 50" aria-label="Transcribing">
          <circle
            cx="25" cy="25" r="20" fill="none"
            stroke="currentColor" strokeWidth="5" strokeLinecap="round"
            strokeDasharray="80 40"
          >
            <animateTransform
              attributeName="transform" type="rotate"
              from="0 25 25" to="360 25 25" dur="0.8s" repeatCount="indefinite"
            />
          </circle>
        </svg>
      ) : (
        <svg
          width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  btn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: '#2a2a2c',
    color: 'var(--text-secondary)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    flexShrink: 0,
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
  },
  recording: {
    background: 'var(--danger)',
    color: '#fff',
    boxShadow: '0 0 8px rgba(192, 57, 43, 0.35)',
  },
  // Compact: small, chrome-less icon for bottom toolbars (matches Claude Code's inline mic).
  btnCompact: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    borderRadius: 5,
    background: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    flexShrink: 0,
    cursor: 'pointer',
    padding: 0,
    transition: 'color 0.15s',
  },
  recordingCompact: {
    color: 'var(--danger)',
  },
};
