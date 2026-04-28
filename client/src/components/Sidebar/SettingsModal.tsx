import { useState, useEffect, useRef } from 'react';
import * as api from '../../api';
import type { SettingsResponse, AccountLoginStatus, KimiLoginStatus, AccountInfo, OneNoteStatus, OneNoteDeviceCode } from '../../api';

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loginStatuses, setLoginStatuses] = useState<Record<number, AccountLoginStatus | null>>({});
  const [kimiStatus, setKimiStatus] = useState<KimiLoginStatus | null>(null);
  const [switching, setSwitching] = useState(false);
  const [loggingIn, setLoggingIn] = useState<number | null>(null);
  const [loggingOut, setLoggingOut] = useState<number | null>(null);
  const [kimiLoggingIn, setKimiLoggingIn] = useState(false);
  const [kimiLoggingOut, setKimiLoggingOut] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // OneNote state
  const [oneNoteStatus, setOneNoteStatus] = useState<OneNoteStatus | null>(null);
  const [deviceCode, setDeviceCode] = useState<OneNoteDeviceCode | null>(null);
  const [authPolling, setAuthPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshStatus = () => {
    setLoginStatuses({ 1: null, 2: null });
    setKimiStatus(null);
    api.fetchLoginStatus()
      .then((resp) => {
        setSettings(resp);
        setLoginStatuses(resp.loginStatuses);
        setKimiStatus(resp.kimiLoginStatus);
      })
      .catch(() => setLoginStatuses({}));
  };

  useEffect(() => {
    api.fetchSettings().then(setSettings).catch(console.error);
    refreshStatus();
    api.fetchOneNoteStatus().then(setOneNoteStatus).catch(console.error);
  }, []);

  // Poll OneNote auth status while device code is pending
  useEffect(() => {
    if (!deviceCode) { if (pollRef.current) clearInterval(pollRef.current); return; }
    setAuthPolling(true);
    pollRef.current = setInterval(() => {
      api.fetchOneNoteStatus().then((s) => {
        setOneNoteStatus(s);
        if (s.status === 'connected') {
          setDeviceCode(null);
          setAuthPolling(false);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }).catch(console.error);
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [deviceCode]);

  const [oneNoteError, setOneNoteError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const handleConnectOneNote = async () => {
    setOneNoteError(null);
    setConnecting(true);
    try {
      const dc = await api.startOneNoteAuth();
      setDeviceCode(dc);
    } catch (err) {
      console.error('[onenote] connect failed:', err);
      setOneNoteError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnectOneNote = async () => {
    try {
      await api.disconnectOneNote();
      setDeviceCode(null);
      setAuthPolling(false);
      const s = await api.fetchOneNoteStatus();
      setOneNoteStatus(s);
    } catch (err) { console.error(err); }
  };

  const handleSwitchAccount = async (target: 1 | 2) => {
    if (!settings || switching || (target === settings.activeAccount && settings.activeProvider === 'claude')) return;
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

  const handleSwitchProvider = async (provider: 'claude' | 'kimi') => {
    if (!settings || switching || settings.activeProvider === provider) return;
    setSwitching(true);
    try {
      const updated = await api.setProvider(provider);
      setSettings(updated);
    } catch (err) {
      console.error('Failed to switch provider:', err);
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

  const handleKimiLogin = async () => {
    setKimiLoggingIn(true);
    try {
      await api.loginKimiAccount();
      refreshStatus();
    } catch (err) {
      console.error('Kimi login failed:', err);
    } finally {
      setKimiLoggingIn(false);
    }
  };

  const handleKimiLogout = async () => {
    setKimiLoggingOut(true);
    try {
      await api.logoutKimiAccount();
      refreshStatus();
    } catch (err) {
      console.error('Kimi logout failed:', err);
    } finally {
      setKimiLoggingOut(false);
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
          <span style={styles.sectionLabel}>Accounts</span>

          {settings ? (
            <div style={styles.accountList}>
              {/* Claude Accounts */}
              {settings.accounts.map((account: AccountInfo) => {
                const id = account.id as 1 | 2;
                const status = loginStatuses[id];
                const isActive = settings.activeProvider === 'claude' && settings.activeAccount === id;
                const isChecking = status === null;
                const isLoggedIn = status?.loggedIn === true;

                return (
                  <div
                    key={`claude-${id}`}
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

              {/* Kimi Account */}
              {(() => {
                const isActive = settings.activeProvider === 'kimi';
                const isChecking = kimiStatus === null;
                const isLoggedIn = kimiStatus?.loggedIn === true;

                return (
                  <div
                    key="kimi"
                    style={{
                      ...styles.accountCard,
                      ...(isActive ? styles.accountCardActive : {}),
                    }}
                  >
                    <div style={styles.accountHeader}>
                      <span style={styles.accountName}>Kimi</span>
                      {isActive && <span style={styles.activeBadge}>Active</span>}
                    </div>

                    <div style={styles.accountStatus}>
                      {isChecking ? (
                        <span style={styles.statusText}>Checking...</span>
                      ) : isLoggedIn ? (
                        <span style={styles.statusTextOk}>
                          {kimiStatus.email || 'Logged in'}
                        </span>
                      ) : (
                        <span style={styles.statusTextErr}>Not logged in</span>
                      )}
                    </div>

                    <div style={styles.accountActions}>
                      {!isActive && (
                        <button
                          onClick={() => handleSwitchProvider('kimi')}
                          disabled={switching}
                          style={styles.actionBtn}
                        >
                          {switching ? 'Switching...' : 'Set Active'}
                        </button>
                      )}
                      {isLoggedIn ? (
                        <button
                          onClick={handleKimiLogout}
                          disabled={kimiLoggingOut}
                          style={styles.actionBtnDanger}
                        >
                          {kimiLoggingOut ? 'Logging out...' : 'Logout'}
                        </button>
                      ) : (
                        <button
                          onClick={handleKimiLogin}
                          disabled={kimiLoggingIn}
                          style={styles.actionBtnPrimary}
                        >
                          {kimiLoggingIn ? 'Logging in...' : 'Login'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : (
            <div style={styles.loading}>Loading...</div>
          )}
        </div>

        {/* ---- OneNote Integration ---- */}
        <div style={{ ...styles.section, marginTop: 8 }}>
          <span style={styles.sectionLabel}>OneNote Integration</span>

          <div style={styles.accountCard}>
            <div style={styles.accountHeader}>
              <span style={styles.accountName}>Microsoft OneNote</span>
              {oneNoteStatus?.status === 'connected' && (
                <span style={styles.activeBadge}>Connected</span>
              )}
              {(oneNoteStatus?.status === 'pending' || connecting) && (
                <span style={{ ...styles.activeBadge, color: '#f0b429', background: 'rgba(240,180,41,0.15)' }}>
                  {connecting ? 'Starting...' : 'Pending'}
                </span>
              )}
            </div>

            {/* Device code instructions — shown after Connect clicked */}
            {deviceCode && (
              <div style={{ margin: '8px 0', padding: '10px', background: 'rgba(74,186,106,0.08)', borderRadius: 6, border: '1px solid rgba(74,186,106,0.25)' }}>
                <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 6px 0' }}>
                  1.{' '}
                  <a href={deviceCode.verificationUrl} target="_blank" rel="noreferrer" style={{ color: '#4aba6a' }}>
                    Open {deviceCode.verificationUrl}
                  </a>
                </p>
                <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 6px 0', letterSpacing: 3, fontFamily: 'monospace' }}>
                  2. Enter: {deviceCode.userCode}
                </p>
                <p style={{ fontSize: 10, color: 'var(--text-secondary)', margin: 0 }}>
                  {authPolling ? '⏳ Waiting... sign in then return here' : 'Sign in with your Microsoft account'}
                </p>
              </div>
            )}

            {/* Inline error display — replaces silent alert() */}
            {oneNoteError && (
              <div style={{ margin: '6px 0', padding: '8px', background: 'rgba(239,100,97,0.1)', borderRadius: 6, border: '1px solid rgba(239,100,97,0.3)' }}>
                <p style={{ fontSize: 10, color: '#ef6461', margin: 0, wordBreak: 'break-all' }}>
                  ❌ {oneNoteError}
                </p>
              </div>
            )}

            <div style={styles.accountActions}>
              {oneNoteStatus?.status === 'connected' ? (
                <button onClick={handleDisconnectOneNote} style={styles.actionBtnDanger}>
                  Disconnect
                </button>
              ) : deviceCode ? (
                <button onClick={handleDisconnectOneNote} style={styles.actionBtnDanger}>
                  Cancel
                </button>
              ) : (
                <button
                  onClick={handleConnectOneNote}
                  disabled={connecting}
                  style={styles.actionBtnPrimary}
                >
                  {connecting ? 'Connecting...' : 'Connect'}
                </button>
              )}
            </div>
          </div>
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
  textInput: {
    flex: 1,
    padding: '6px 8px',
    fontSize: 11,
    color: 'var(--text-primary)',
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: 6,
    outline: 'none',
    fontFamily: 'monospace',
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
