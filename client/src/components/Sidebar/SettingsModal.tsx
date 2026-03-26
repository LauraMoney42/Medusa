import { useState, useEffect } from 'react';
import * as api from '../../api';
import type { SettingsResponse, AccountLoginStatus, AccountInfo } from '../../api';

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loginStatuses, setLoginStatuses] = useState<Record<number, AccountLoginStatus | null>>({});
  const [switching, setSwitching] = useState(false);
  const [loggingIn, setLoggingIn] = useState<number | null>(null);
  const [loggingOut, setLoggingOut] = useState<number | null>(null);
  const [restarting, setRestarting] = useState(false);

  const refreshStatus = () => {
    setLoginStatuses({ 1: null, 2: null });
    api.fetchLoginStatus()
      .then((resp) => {
        setSettings(resp);
        setLoginStatuses(resp.loginStatuses);
      })
      .catch(() => setLoginStatuses({}));
  };

  useEffect(() => {
    api.fetchSettings().then(setSettings).catch(console.error);
    refreshStatus();
  }, []);

  const handleSwitchAccount = async (target: 1 | 2) => {
    if (!settings || switching || target === settings.activeAccount) return;
    setSwitching(true);
    try {
      const updated = await api.setAccount(target);
      setSettings(updated);
    } catch (err) {
      console.error('Failed to switch account:', err);
    } finally {
      setSwitching(false);
    }
  };

  const handleLogin = async (accountId: 1 | 2) => {
    setLoggingIn(accountId);
    try {
      await api.loginClaudeAccount(accountId);
      refreshStatus();
    } catch (err) {
      console.error(`Login for account ${accountId} failed:`, err);
    } finally {
      setLoggingIn(null);
    }
  };

  const handleLogout = async (accountId: 1 | 2) => {
    setLoggingOut(accountId);
    try {
      await api.logoutClaudeAccount(accountId);
      refreshStatus();
    } catch (err) {
      console.error(`Logout for account ${accountId} failed:`, err);
    } finally {
      setLoggingOut(null);
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

  return (
    <>
      <div style={styles.overlay} onClick={onClose} />
      <div style={styles.modal}>
        <div style={styles.header}>
          <h3 style={styles.title}>Settings</h3>
          <button onClick={onClose} style={styles.closeBtn} title="Close">✕</button>
        </div>

        <div style={styles.section}>
          <span style={styles.sectionLabel}>Claude Accounts</span>

          {settings ? (
            <div style={styles.accountList}>
              {settings.accounts.map((account: AccountInfo) => {
                const id = account.id as 1 | 2;
                const status = loginStatuses[id];
                const isActive = settings.activeAccount === id;
                const isChecking = status === null;
                const isLoggedIn = status?.loggedIn === true;

                return (
                  <div
                    key={id}
                    style={{
                      ...styles.accountCard,
                      ...(isActive ? styles.accountCardActive : {}),
                    }}
                  >
                    <div style={styles.accountHeader}>
                      <span style={styles.accountName}>{account.name}</span>
                      {isActive && <span style={styles.activeBadge}>Active</span>}
                    </div>

                    <div style={styles.accountStatus}>
                      {isChecking ? (
                        <span style={styles.statusText}>Checking...</span>
                      ) : isLoggedIn ? (
                        <span style={styles.statusTextOk}>
                          {status.email}
                          {status.subscriptionType ? ` · ${status.subscriptionType}` : ''}
                        </span>
                      ) : (
                        <span style={styles.statusTextErr}>Not logged in</span>
                      )}
                    </div>

                    <div style={styles.accountActions}>
                      {!isActive && (
                        <button
                          onClick={() => handleSwitchAccount(id)}
                          disabled={switching}
                          style={styles.actionBtn}
                        >
                          {switching ? 'Switching...' : 'Set Active'}
                        </button>
                      )}
                      {isLoggedIn ? (
                        <button
                          onClick={() => handleLogout(id)}
                          disabled={loggingOut === id}
                          style={styles.actionBtnDanger}
                        >
                          {loggingOut === id ? 'Logging out...' : 'Logout'}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleLogin(id)}
                          disabled={loggingIn === id}
                          style={styles.actionBtnPrimary}
                        >
                          {loggingIn === id ? 'Logging in...' : 'Login'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={styles.loading}>Loading...</div>
          )}
        </div>

        <button
          onClick={handleRestart}
          disabled={restarting}
          style={styles.restartBtn}
        >
          {restarting ? 'Restarting...' : 'Restart App'}
        </button>
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
    width: 360,
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
    marginBottom: 16,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    display: 'block',
    marginBottom: 10,
  },
  accountList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  accountCard: {
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    padding: '12px',
  },
  accountCardActive: {
    border: '1px solid rgba(74, 186, 106, 0.4)',
    background: 'rgba(74, 186, 106, 0.06)',
  },
  accountHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  accountName: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  activeBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: '#4aba6a',
    background: 'rgba(74, 186, 106, 0.15)',
    padding: '2px 8px',
    borderRadius: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  accountStatus: {
    marginBottom: 8,
    minHeight: 16,
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
  accountActions: {
    display: 'flex',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    padding: '6px 0',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-primary)',
    background: 'rgba(255, 255, 255, 0.08)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: 6,
    cursor: 'pointer',
    textAlign: 'center',
  },
  actionBtnPrimary: {
    flex: 1,
    padding: '6px 0',
    fontSize: 11,
    fontWeight: 600,
    color: '#fff',
    background: 'rgba(74, 186, 106, 0.25)',
    border: '1px solid rgba(74, 186, 106, 0.4)',
    borderRadius: 6,
    cursor: 'pointer',
    textAlign: 'center',
  },
  actionBtnDanger: {
    flex: 1,
    padding: '6px 0',
    fontSize: 11,
    fontWeight: 600,
    color: '#ef6461',
    background: 'rgba(239, 100, 97, 0.1)',
    border: '1px solid rgba(239, 100, 97, 0.25)',
    borderRadius: 6,
    cursor: 'pointer',
    textAlign: 'center',
  },
  loading: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    padding: '8px 0',
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
};
