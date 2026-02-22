import { useState, useEffect } from 'react';
import * as api from '../../api';
import type { SettingsResponse, AccountLoginStatus } from '../../api';

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [switching, setSwitching] = useState(false);
  const [loginStatuses, setLoginStatuses] = useState<Record<number, AccountLoginStatus | null>>({});
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    api.fetchSettings().then(setSettings).catch(console.error);

    setLoginStatuses({ 1: null, 2: null });
    api.fetchLoginStatus()
      .then((resp) => setLoginStatuses(resp.loginStatuses))
      .catch(() => setLoginStatuses({}));
  }, []);

  // Toggle: switch account, log out the old one, and restart the server
  const handleToggle = async () => {
    if (!settings || switching) return;
    const previous: 1 | 2 = settings.activeAccount;
    const target: 1 | 2 = previous === 1 ? 2 : 1;
    setSwitching(true);
    try {
      // Switch to the new account
      const updated = await api.setAccount(target);
      setSettings(updated);
      // Log out the account we just toggled off
      await api.logoutClaudeAccount(previous).catch(() => {});
      // Restart the server so everything picks up the new account cleanly
      await api.restartApp().catch(() => {});
    } catch (err) {
      console.error('Failed to switch account:', err);
    } finally {
      setSwitching(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await api.restartApp();
    } catch {
      // Server is shutting down — connection error is expected
    }
  };


  const activeStatus = settings ? loginStatuses[settings.activeAccount] : undefined;
  const isChecking = activeStatus === null;

  return (
    <>
      <div style={styles.overlay} onClick={onClose} />
      <div style={styles.modal}>
        <div style={styles.header}>
          <h3 style={styles.title}>Settings</h3>
          <button onClick={onClose} style={styles.closeBtn} title="Close">✕</button>
        </div>

        <div style={styles.section}>
          <span style={styles.sectionLabel}>Claude Account</span>

          {settings ? (
            <>
              {/* Toggle switch — shows email when logged in, fallback to account name */}
              <button
                onClick={handleToggle}
                disabled={switching}
                style={styles.toggle}
              >
                <div style={styles.toggleTrack}>
                  <span
                    style={{
                      ...styles.toggleOption,
                      ...(settings.activeAccount === 1 ? styles.toggleOptionActive : {}),
                    }}
                    title={loginStatuses[1]?.email || settings.accounts[0]?.name || 'Account 1'}
                  >
                    {loginStatuses[1]?.email || settings.accounts[0]?.name || 'Account 1'}
                  </span>
                  <span
                    style={{
                      ...styles.toggleOption,
                      ...(settings.activeAccount === 2 ? styles.toggleOptionActive : {}),
                    }}
                    title={loginStatuses[2]?.email || settings.accounts[1]?.name || 'Account 2'}
                  >
                    {loginStatuses[2]?.email || settings.accounts[1]?.name || 'Account 2'}
                  </span>
                </div>
              </button>

              {/* Active account info */}
              <div style={styles.statusRow}>
                {isChecking ? (
                  <span style={styles.statusText}>Checking…</span>
                ) : activeStatus?.loggedIn ? (
                  <span style={styles.statusTextOk}>
                    {activeStatus.email}
                    {activeStatus.subscriptionType ? ` · ${activeStatus.subscriptionType}` : ''}
                  </span>
                ) : activeStatus && !activeStatus.loggedIn ? (
                  <span style={styles.statusTextErr}>Not logged in</span>
                ) : null}
              </div>
            </>
          ) : (
            <div style={styles.loading}>Loading…</div>
          )}
        </div>

        <div style={styles.note}>
          Toggling accounts logs out the current account and restarts the server.
        </div>

        {/* Restart button — always visible for quick access */}
        <button
          onClick={handleRestart}
          disabled={restarting}
          style={styles.restartBtn}
        >
          {restarting ? 'Restarting…' : 'Restart App'}
        </button>
        <div style={styles.restartHint}>
          Restart to apply login/logout changes from terminal.
        </div>
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    zIndex: 999,
  },
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
    width: 340,
    maxWidth: '90vw',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: 0,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: 14,
    padding: '2px 6px',
    borderRadius: 4,
  },
  section: {
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    display: 'block',
    marginBottom: 8,
  },
  // Toggle switch (segmented control)
  toggle: {
    display: 'block',
    width: '100%',
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
  },
  toggleTrack: {
    display: 'flex',
    background: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 8,
    padding: 3,
    gap: 2,
  },
  toggleOption: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    padding: '8px 4px',
    borderRadius: 6,
    transition: 'all 0.15s ease',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  toggleOptionActive: {
    background: 'rgba(74, 186, 106, 0.2)',
    color: '#4aba6a',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)',
  },
  statusRow: {
    marginTop: 8,
    minHeight: 18,
  },
  statusText: {
    fontSize: 11,
    color: 'var(--text-secondary)',
  },
  statusTextOk: {
    fontSize: 11,
    color: '#4aba6a',
  },
  statusTextErr: {
    fontSize: 11,
    color: '#ef6461',
  },
  loading: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    padding: '8px 0',
  },
  note: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
    marginBottom: 16,
    fontStyle: 'italic',
  },
  restartBtn: {
    display: 'block',
    width: '100%',
    padding: '9px 0',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    background: 'rgba(255, 255, 255, 0.08)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: 6,
    cursor: 'pointer',
    textAlign: 'center',
  },
  restartHint: {
    fontSize: 10,
    color: 'var(--text-secondary)',
    textAlign: 'center',
    marginTop: 6,
    opacity: 0.7,
  },
};
