import { useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore } from '../../stores/chatStore';
import MessageList from './MessageList';
import ChatInput from '../Input/ChatInput';
import KanbanStrip from './KanbanStrip';

interface ChatPaneProps {
  onMenuToggle?: () => void;
}

export default function ChatPane({ onMenuToggle }: ChatPaneProps) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const loadMessages = useChatStore((s) => s.loadMessages);

  // Load persisted chat history when switching sessions
  useEffect(() => {
    if (activeSessionId) {
      loadMessages(activeSessionId);
    }
  }, [activeSessionId, loadMessages]);

  if (!activeSessionId) {
    return (
      <div style={styles.container}>
        {/* Mobile menu button */}
        <div className="mobile-header" style={styles.mobileHeader}>
          <button onClick={onMenuToggle} style={styles.menuBtn}>
            &#9776;
          </button>
        </div>

        <div style={styles.empty}>
          <img src="/MedusaIcon.png" alt="Medusa" style={styles.emptyIcon} />
          <h2 style={styles.emptyTitle}>Welcome to Medusa</h2>
          <p style={styles.emptyText}>
            Select Medusa or another bot from the sidebar to begin
          </p>
          <p style={styles.creditText}>
            Created by{' '}
            <a
              href="https://www.linkedin.com/in/laura-money/"
              target="_blank"
              rel="noopener noreferrer"
              style={styles.creditLink}
            >
              Laura Money
            </a>
            {' '}at{' '}
            <a
              href="https://kindcode.us/"
              target="_blank"
              rel="noopener noreferrer"
              style={styles.creditLink}
            >
              KindCode
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Mobile menu button + session name header */}
      <div style={styles.topBar}>
        <div className="mobile-header" style={styles.mobileHeader}>
          <button onClick={onMenuToggle} style={styles.menuBtn}>
            &#9776;
          </button>
        </div>
        <span style={styles.sessionName}>
          {activeSession?.name ?? 'Session'}
        </span>
      </div>

      {/* Kanban post-it strip */}
      <KanbanStrip botName={activeSession?.name ?? ''} />

      <MessageList sessionId={activeSessionId} botName={activeSession?.name} />
      <ChatInput sessionId={activeSessionId} botName={activeSession?.name} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--bg-primary)',
    minWidth: 0,
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 16px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(26, 26, 28, 0.75)',
    backdropFilter: 'blur(20px) saturate(1.2)',
    WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
    flexShrink: 0,
  } as React.CSSProperties,
  mobileHeader: {
    alignItems: 'center',
  },
  menuBtn: {
    fontSize: 20,
    padding: '4px 8px',
    color: 'var(--text-secondary)',
  },
  sessionName: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    color: 'var(--text-muted)',
  },
  emptyIcon: {
    width: '33vh',
    height: '33vh',
    minWidth: 160,
    minHeight: 160,
    maxWidth: 320,
    maxHeight: 320,
    marginBottom: 16,
    borderRadius: '50%',
    objectFit: 'cover' as const,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  emptyText: {
    fontSize: 15,
    color: 'var(--text-secondary)',
  },
  creditText: {
    fontSize: 14,
    color: 'var(--text-muted)',
    marginTop: 6,
  },
  creditLink: {
    color: 'var(--text-muted)',
    textDecoration: 'underline',
    textDecorationColor: 'rgba(255,255,255,0.15)',
    textUnderlineOffset: 2,
    transition: 'color 0.15s',
  },
};
