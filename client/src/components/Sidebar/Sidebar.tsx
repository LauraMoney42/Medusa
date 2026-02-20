import { useState, useCallback } from 'react';
import SessionList from './SessionList';
import NewSessionButton from './NewSessionButton';
import SettingsModal from './SettingsModal';
import { useSessionStore } from '../../stores/sessionStore';
import { useUnreadHubCount } from '../../stores/hubStore';
import * as api from '../../api';

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const activeView = useSessionStore((s) => s.activeView);
  const setActiveView = useSessionStore((s) => s.setActiveView);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const unreadCount = useUnreadHubCount();
  const sessions = useSessionStore((s) => s.sessions);
  const statuses = useSessionStore((s) => s.statuses);
  const [shutdownModalOpen, setShutdownModalOpen] = useState(false);
  const [shutdownLoading, setShutdownLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handleProjectsClick = () => {
    if (activeView === 'project') {
      setActiveView('chat');
    } else {
      setActiveSession(null);
      setActiveView('project');
    }
  };

  const handleHubClick = () => {
    if (activeView === 'hub') {
      // Toggle back to chat — don't force a session, just switch view
      setActiveView('chat');
    } else {
      // Switching to Hub — clear active session so no chat stays highlighted
      setActiveSession(null);
      setActiveView('hub');
    }
  };

  const handleShutdown = useCallback(async () => {
    setShutdownLoading(true);
    try {
      await api.shutdown();
      // Server should close connection, but show success message just in case
      setShutdownModalOpen(false);
    } catch (err) {
      console.error('Shutdown failed:', err);
      alert('Failed to trigger shutdown. Check console.');
    } finally {
      setShutdownLoading(false);
    }
  }, []);

  return (
    <>
      {/* Overlay for mobile */}
      {open && (
        <div
          className="sidebar-overlay"
          onClick={onClose}
          style={styles.overlay}
        />
      )}

      <aside
        className={`sidebar${open ? ' open' : ''}`}
        style={styles.sidebar}
      >
        <div style={styles.header}>
          <h2 style={styles.title}>Medusa</h2>
          <button
            onClick={() => setSettingsOpen(true)}
            style={styles.gearBtn}
            title="Settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>

        {/* Hub button */}
        <button
          onClick={handleHubClick}
          style={{
            ...styles.hubBtn,
            background: activeView === 'hub'
              ? 'rgba(26, 122, 60, 0.15)'
              : 'transparent',
            color: activeView === 'hub'
              ? '#4aba6a'
              : 'var(--text-secondary)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          <span>Hub</span>
          {unreadCount > 0 && activeView !== 'hub' && (
            <span style={styles.badge}>{unreadCount}</span>
          )}
        </button>

        {/* Stop All button */}
        <button
          onClick={() => setShutdownModalOpen(true)}
          style={styles.stopBtn}
          title="Gracefully shutdown the server"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6" />
          </svg>
          <span>Stop All</span>
        </button>

        {/* Projects button */}
        <button
          onClick={handleProjectsClick}
          style={{
            ...styles.hubBtn,
            background: activeView === 'project'
              ? 'rgba(26, 122, 60, 0.15)'
              : 'transparent',
            color: activeView === 'project'
              ? '#4aba6a'
              : 'var(--text-secondary)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span>Projects</span>
        </button>

        <SessionList />
        <NewSessionButton />

        {/* Settings modal */}
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

        {/* Shutdown confirmation modal */}
        {shutdownModalOpen && (
          <>
            <div style={styles.modalOverlay} onClick={() => !shutdownLoading && setShutdownModalOpen(false)} />
            <div style={styles.modal}>
              <h3 style={styles.modalTitle}>Stop All Bots?</h3>
              <p style={styles.modalText}>
                {sessions.length > 0 ? (
                  <>
                    <strong>{sessions.length}</strong> {sessions.length === 1 ? 'bot is' : 'bots are'} currently active.
                    {(() => {
                      const busyCount = sessions.filter((s) => statuses[s.id] === 'busy').length;
                      return busyCount > 0 && (
                        <>
                          <br />
                          <strong>{busyCount}</strong> {busyCount === 1 ? 'is' : 'are'} still working.
                        </>
                      );
                    })()}
                  </>
                ) : (
                  <>No active bots. Are you sure?</>
                )}
              </p>
              <div style={styles.modalActions}>
                <button
                  onClick={() => setShutdownModalOpen(false)}
                  style={styles.cancelBtn}
                  disabled={shutdownLoading}
                >
                  Cancel
                </button>
                <button
                  onClick={handleShutdown}
                  style={styles.shutdownBtn}
                  disabled={shutdownLoading}
                >
                  {shutdownLoading ? 'Shutting down...' : 'Shutdown Server'}
                </button>
              </div>
            </div>
          </>
        )}
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
  stopBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 18px',
    border: 'none',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    background: 'transparent',
    transition: 'background 0.15s, color 0.15s',
  } as React.CSSProperties,
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    zIndex: 999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as React.CSSProperties,
  modal: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 1000,
    background: '#2c2c2e',
    border: '1px solid rgba(255, 255, 255, 0.10)',
    borderRadius: 'var(--radius-md)',
    padding: '20px',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
    maxWidth: 380,
    width: '90%',
  } as React.CSSProperties,
  modalTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: '0 0 8px 0',
  },
  modalText: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    margin: '0 0 16px 0',
    lineHeight: 1.4,
  },
  modalActions: {
    display: 'flex',
    gap: 8,
  },
  cancelBtn: {
    flex: 1,
    padding: '8px 12px',
    background: 'rgba(255, 255, 255, 0.08)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  shutdownBtn: {
    flex: 1,
    padding: '8px 12px',
    background: '#ef4444',
    color: '#fff',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    transition: 'background 0.15s, opacity 0.15s',
  },
  sidebar: {
    width: 'var(--sidebar-width)',
    minWidth: 'var(--sidebar-width)',
    height: '100%',
    background: '#1a1a1c',
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid rgba(255, 255, 255, 0.08)',
  } as React.CSSProperties,
  header: {
    padding: '18px 18px 14px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  gearBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: '4px',
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    opacity: 0.6,
    transition: 'opacity 0.15s',
  } as React.CSSProperties,
  title: {
    fontSize: 17,
    fontWeight: 700,
    color: '#1a7a3c',
    letterSpacing: '0.04em',
    textShadow: '0 0 20px rgba(26, 122, 60, 0.3)',
  },
  hubBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 18px',
    border: 'none',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
    transition: 'background 0.15s, color 0.15s',
    position: 'relative',
  } as React.CSSProperties,
  badge: {
    marginLeft: 'auto',
    fontSize: 10,
    fontWeight: 700,
    background: '#ef4444',
    color: '#fff',
    borderRadius: 10,
    padding: '1px 6px',
    lineHeight: '14px',
    minWidth: 18,
    textAlign: 'center',
  } as React.CSSProperties,
};
