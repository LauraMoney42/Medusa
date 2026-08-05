import { useState, useEffect, useRef, useCallback } from 'react';
import { getSocket } from '../../socket';

interface SimulatorPaneProps {
  onMenuToggle?: () => void;
}

type SimulatorStatus = { available: boolean; message?: string; deviceName?: string };

type SimulatorInput =
  | { kind: 'tap'; nx: number; ny: number }
  | { kind: 'swipe'; nx1: number; ny1: number; nx2: number; ny2: number }
  | { kind: 'text'; text: string }
  | { kind: 'button'; name: 'HOME' | 'LOCK' };

// Screen-space distance (px) beyond which a mousedown/mouseup pair is treated
// as a swipe instead of a tap.
const SWIPE_THRESHOLD_PX = 8;

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    background: '#1a1a1c',
    height: '100%',
  },
  header: {
    padding: '14px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  menuButton: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    padding: 0,
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    color: '#4aba6a',
    margin: 0,
  },
  hwButton: {
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 5,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: 12,
    padding: '4px 10px',
  },
  driveHint: {
    marginLeft: 'auto',
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  body: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 12,
    position: 'relative',
    background: '#0e0e10',
    gap: 12,
  },
  frame: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    borderRadius: 6,
    boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
    cursor: 'crosshair',
    display: 'block',
    userSelect: 'none',
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    textAlign: 'center',
    maxWidth: 380,
  },
  placeholderMessage: {
    color: 'var(--text-secondary)',
    fontSize: 14,
  },
  placeholderHint: {
    color: 'var(--text-muted)',
    fontSize: 12,
  },
  textForm: {
    display: 'flex',
    gap: 8,
    width: '100%',
    maxWidth: 480,
  },
  textInput: {
    flex: 1,
    background: '#232325',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 6,
    padding: '8px 10px',
    color: 'var(--text-primary)',
    fontSize: 13,
    outline: 'none',
  },
  textButton: {
    background: 'transparent',
    border: '1px solid rgba(74,186,106,0.5)',
    borderRadius: 6,
    color: '#4aba6a',
    cursor: 'pointer',
    fontSize: 13,
    padding: '8px 14px',
  },
};

export default function SimulatorPane({ onMenuToggle }: SimulatorPaneProps) {
  const [frame, setFrame] = useState<string | null>(null);
  const [status, setStatus] = useState<SimulatorStatus | null>(null);
  const [textValue, setTextValue] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const downRef = useRef<{ clientX: number; clientY: number; nx: number; ny: number } | null>(null);

  useEffect(() => {
    const socket = getSocket();
    const onFrame = (data: string) => setFrame(data);
    const onStatus = (s: SimulatorStatus) => setStatus(s);
    socket.on('simulator:frame', onFrame);
    socket.on('simulator:status', onStatus);
    socket.emit('simulator:start');
    return () => {
      socket.emit('simulator:stop');
      socket.off('simulator:frame', onFrame);
      socket.off('simulator:status', onStatus);
    };
  }, []);

  // Map a pointer position over the <img> to normalized [0,1] coords of the
  // actual frame content, accounting for object-fit: contain letterboxing.
  const norm = useCallback((clientX: number, clientY: number): { nx: number; ny: number } | null => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;
    const rect = img.getBoundingClientRect();
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const dispW = img.naturalWidth * scale;
    const dispH = img.naturalHeight * scale;
    const offX = rect.left + (rect.width - dispW) / 2;
    const offY = rect.top + (rect.height - dispH) / 2;
    const x = clientX - offX;
    const y = clientY - offY;
    if (x < 0 || y < 0 || x > dispW || y > dispH) return null;
    return { nx: x / dispW, ny: y / dispH };
  }, []);

  const emit = useCallback((input: SimulatorInput) => {
    getSocket().emit('simulator:input', input);
  }, []);

  // Tap-vs-swipe disambiguation: mousedown only records the start position
  // (screen coords + normalized coords) and emits nothing. mouseup computes
  // the end position and compares the screen-space distance travelled to
  // SWIPE_THRESHOLD_PX. Below the threshold we emit a single tap using the
  // down-position as the target; above it we emit a swipe from down to up.
  // Either way exactly one input event is emitted per gesture.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const p = norm(e.clientX, e.clientY);
    if (!p) {
      downRef.current = null;
      return;
    }
    downRef.current = { clientX: e.clientX, clientY: e.clientY, nx: p.nx, ny: p.ny };
  }, [norm]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const down = downRef.current;
    downRef.current = null;
    if (!down) return;
    const dx = e.clientX - down.clientX;
    const dy = e.clientY - down.clientY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > SWIPE_THRESHOLD_PX) {
      const p = norm(e.clientX, e.clientY);
      if (p) {
        emit({ kind: 'swipe', nx1: down.nx, ny1: down.ny, nx2: p.nx, ny2: p.ny });
      }
    } else {
      emit({ kind: 'tap', nx: down.nx, ny: down.ny });
    }
  }, [norm, emit]);

  const handleTextSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const value = textValue.trim();
    if (!value) return;
    emit({ kind: 'text', text: value });
    setTextValue('');
  }, [textValue, emit]);

  const handleHome = useCallback(() => emit({ kind: 'button', name: 'HOME' }), [emit]);
  const handleLock = useCallback(() => emit({ kind: 'button', name: 'LOCK' }), [emit]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button type="button" style={styles.menuButton} onClick={onMenuToggle} aria-label="Toggle menu">
          <svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} fill="none">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <h2 style={styles.title}>Simulator</h2>
        <button type="button" style={styles.hwButton} onClick={handleHome}>Home</button>
        <button type="button" style={styles.hwButton} onClick={handleLock}>Lock</button>
        {frame && status?.deviceName && (
          <span style={styles.driveHint}>{status.deviceName} · live · tap, swipe, type to control</span>
        )}
      </div>
      <div style={styles.body}>
        {frame ? (
          <>
            <img
              ref={imgRef}
              src={`data:image/png;base64,${frame}`}
              alt="Live iOS Simulator"
              draggable={false}
              style={styles.frame}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
            />
            <form style={styles.textForm} onSubmit={handleTextSubmit}>
              <input
                type="text"
                style={styles.textInput}
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                placeholder="Type text into the simulator..."
              />
              <button type="submit" style={styles.textButton}>Send</button>
            </form>
          </>
        ) : (
          <div style={styles.placeholder}>
            <div style={styles.placeholderMessage}>{status?.message ?? 'Connecting to the simulator…'}</div>
            <div style={styles.placeholderHint}>
              Boot an iOS Simulator via Xcode to see it live here.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
