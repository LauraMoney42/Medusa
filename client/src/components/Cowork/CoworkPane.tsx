import { useState, useEffect } from 'react';
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
      </div>
      <div style={styles.body}>
        {frame ? (
          <img src={`data:image/jpeg;base64,${frame}`} alt="Live browser" style={styles.frame} />
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
