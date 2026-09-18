import { useEffect, useState } from 'react';
import ChatList from './ChatList';
import NewChatModal from './NewChatModal';
import SettingsModal from './SettingsModal';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsTabStore } from '../../stores/settingsTabStore';

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

const ISSUES_URL = 'https://github.com/LauraMoney42/Medusa/issues';

/**
 * Left rail: app mark, the "Recent" chat list with search, and a bottom group
 * of New Chat / Tools / Settings / Bug + Feature.
 *
 * Hub, Arcade, Usage and Stop All are gone from here. Usage and Stop All moved
 * into Settings tabs; Browser and Simulator moved to the chat header icons.
 */
export default function Sidebar({ open, onClose }: SidebarProps) {
  const activeView = useSessionStore((s) => s.activeView);
  const setActiveView = useSessionStore((s) => s.setActiveView);
  const [query, setQuery] = useState('');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openRequested = useSettingsTabStore((st) => st.openRequested);
  const clearOpenRequest = useSettingsTabStore((st) => st.clearOpenRequest);

  // The mic tier banner (VoiceTierBadge) can ask Settings to open straight to
  // the Providers tab even when the modal isn't up yet.
  useEffect(() => {
    if (openRequested) {
      setSettingsOpen(true);
      clearOpenRequest();
    }
  }, [openRequested, clearOpenRequest]);

  // Opened with the system browser, not an in-app tab: this is a link out to
  // the project's issue tracker, which the user signs into as themselves.
  const openIssues = () => window.open(ISSUES_URL, '_blank', 'noopener,noreferrer');

  return (
    <>
      {open && <div className="sidebar-overlay" onClick={onClose} style={styles.overlay} />}

      <aside className={`sidebar${open ? ' open' : ''}`} style={styles.sidebar}>
        <div style={styles.header}>
          <img src="/MedusaIcon.png" alt="" style={styles.mark} />
          <h2 style={styles.title}>Medusa</h2>
        </div>

        <div style={styles.searchWrap}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            style={styles.search}
            aria-label="Search chats"
          />
        </div>

        <div style={styles.sectionLabel}>Recent</div>

        <div style={styles.listScroll}>
          <ChatList query={query} />
        </div>

        <div style={styles.bottomGroup}>
          <button onClick={() => setNewChatOpen(true)} style={styles.primaryItem}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>New Chat</span>
          </button>

          <button
            onClick={() => setActiveView(activeView === 'tools' ? 'chat' : 'tools')}
            style={{
              ...styles.item,
              color: activeView === 'tools' ? '#4aba6a' : 'var(--text-secondary)',
              background: activeView === 'tools' ? 'rgba(26, 122, 60, 0.12)' : 'transparent',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 1 5.4-5.4l-2.5 2.5" />
            </svg>
            <span>Tools</span>
          </button>

          <button onClick={() => setSettingsOpen(true)} style={styles.item}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Settings</span>
          </button>

          <button onClick={openIssues} style={styles.item} title={ISSUES_URL}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <line x1="12" y1="8" x2="12" y2="13" />
              <line x1="12" y1="16.5" x2="12" y2="16.5" />
            </svg>
            <span>Bug / Feature</span>
          </button>
        </div>

        {newChatOpen && <NewChatModal onClose={() => setNewChatOpen(false)} />}
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      </aside>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.4)',
    zIndex: 99,
  },
  sidebar: {
    width: 'var(--sidebar-width)',
    minWidth: 'var(--sidebar-width)',
    height: '100%',
    background: 'var(--bg-tertiary)',
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid var(--border)',
  },
  header: {
    padding: '16px 16px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
  },
  mark: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    border: '1px solid var(--border-glow)',
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    color: '#4aba6a',
    letterSpacing: '0.04em',
    margin: 0,
  },
  searchWrap: { padding: '0 12px 10px' },
  search: {
    width: '100%',
    padding: '6px 9px',
    fontSize: 12,
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(255,255,255,0.04)',
    color: 'var(--text-primary)',
    fontFamily: 'inherit',
    outline: 'none',
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    padding: '2px 16px 6px',
  },
  listScroll: {
    flex: 1,
    overflowY: 'auto',
    minHeight: 0,
  },
  bottomGroup: {
    borderTop: '1px solid var(--border)',
    padding: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    width: '100%',
    padding: '8px 9px',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    background: 'transparent',
    textAlign: 'left',
  },
  primaryItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    width: '100%',
    padding: '8px 9px',
    border: '1px solid var(--border-glow)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    color: '#4aba6a',
    background: 'rgba(26, 122, 60, 0.12)',
    textAlign: 'left',
    marginBottom: 4,
  },
};
