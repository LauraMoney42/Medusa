import { useState, useEffect, useRef, useCallback } from 'react';
import { getSocket } from '../../socket';

interface CoworkPaneProps {
  onMenuToggle?: () => void;
}

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
  body: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 12,
    position: 'relative',
    background: '#0e0e10',
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
  frameWrap: {
    outline: 'none',
    maxWidth: '100%',
    maxHeight: '100%',
    display: 'flex',
  },
  driveHint: {
    marginLeft: 'auto',
    fontSize: 11,
    color: 'var(--text-muted)',
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
};

export default function CoworkPane({ onMenuToggle }: CoworkPaneProps) {
  const [frame, setFrame] = useState<string | null>(null);
  const [status, setStatus] = useState<{ available: boolean; message?: string } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastMoveRef = useRef(0);

  useEffect(() => {
    const socket = getSocket();
    const onFrame = (data: string) => setFrame(data);
    const onStatus = (s: { available: boolean; message?: string }) => setStatus(s);
    socket.on('cowork:frame', onFrame);
    socket.on('cowork:status', onStatus);
    socket.emit('cowork:start');
    return () => {
      socket.emit('cowork:stop');
      socket.off('cowork:frame', onFrame);
      socket.off('cowork:status', onStatus);
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

  const emit = useCallback((input: unknown) => {
    getSocket().emit('cowork:input', input);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    wrapRef.current?.focus();
    const p = norm(e.clientX, e.clientY);
    if (p) emit({ kind: 'mouse', type: 'mousePressed', nx: p.nx, ny: p.ny, button: 'left', clickCount: 1 });
  }, [norm, emit]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const p = norm(e.clientX, e.clientY);
    if (p) emit({ kind: 'mouse', type: 'mouseReleased', nx: p.nx, ny: p.ny, button: 'left', clickCount: 1 });
  }, [norm, emit]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const now = Date.now();
    if (now - lastMoveRef.current < 50) return; // throttle to ~20/s
    lastMoveRef.current = now;
    const p = norm(e.clientX, e.clientY);
    if (p) emit({ kind: 'mouse', type: 'mouseMoved', nx: p.nx, ny: p.ny });
  }, [norm, emit]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    const p = norm(e.clientX, e.clientY);
    if (p) emit({ kind: 'wheel', nx: p.nx, ny: p.ny, dx: e.deltaX, dy: e.deltaY });
  }, [norm, emit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const special: Record<string, number> = {
      Enter: 13, Backspace: 8, Tab: 9, Escape: 27,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
    };
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      emit({ kind: 'text', text: e.key });
    } else if (special[e.key] !== undefined) {
      e.preventDefault();
      const vk = special[e.key];
      emit({ kind: 'key', type: 'keyDown', key: e.key, code: e.code, windowsVirtualKeyCode: vk });
      emit({ kind: 'key', type: 'keyUp', key: e.key, code: e.code, windowsVirtualKeyCode: vk });
    }
  }, [emit]);

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
        <h2 style={styles.title}>Browser</h2>
        {frame && <span style={styles.driveHint}>live · click, scroll, type to control</span>}
      </div>
      <div style={styles.body}>
        {frame ? (
          <div ref={wrapRef} tabIndex={0} onKeyDown={handleKeyDown} style={styles.frameWrap}>
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${frame}`}
              alt="Live browser"
              draggable={false}
              style={styles.frame}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onMouseMove={handleMouseMove}
              onWheel={handleWheel}
            />
          </div>
        ) : (
          <div style={styles.placeholder}>
            <div style={styles.placeholderMessage}>{status?.message ?? 'Connecting to the browser…'}</div>
            <div style={styles.placeholderHint}>
              Start Chrome with --remote-debugging-port=9222 to see it live here.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
