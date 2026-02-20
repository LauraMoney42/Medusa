import { useState, useEffect } from 'react';
import * as api from '../../api';
import type { SettingsResponse, AccountLoginStatus } from '../../api';

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [switching, setSwitching] = useState(false);
  // Per-account login status: undefined = not yet checked, null = checking
  const [loginStatuses, setLoginStatuses] = useState<Record<number, AccountLoginStatus | null>>({});
  // Track which accounts have a login/logout action in progress
  const [actionInProgress, setActionInProgress] = useState<Record<number, 'login' | 'logout' | null>>({});

  // Load settings instantly, then kick off async login status check
  useEffect(() => {
    api.fetchSettings().then(setSettings).catch(console.error);

    // Mark both accounts as "checking"
    setLoginStatuses({ 1: null, 2: null });
    api.fetchLoginStatus()
      .then((resp) => {
        setLoginStatuses(resp.loginStatuses);
      })
      .catch(() => {
        // If status check fails, show unknown state
        setLoginStatuses({});
      });
  }, []);

  const handleSwitch = async (accountId: 1 | 2) => {
    if (!settings || settings.activeAccount === accountId || switching) return;
    setSwitching(true);
    try {
      const updated = await api.setAccount(accountId);
      setSettings(updated);
    } catch (err) {
      console.error('Failed to switch account:', err);
    } finally {
      setSwitching(false);
    }
  };

  const handleLogin = async (accountId: 1 | 2) => {
    setActionInProgress((prev) => ({ ...prev, [accountId]: 'login' }));
    try {
      const result = await api.loginClaudeAccount(accountId);
      setLoginStatuses((prev) => ({ ...prev, [accountId]: result.loginStatus }));
    } catch (err) {
      console.error(`Login failed for account ${accountId}:`, err);
    } finally {
      setActionInProgress((prev) => ({ ...prev, [accountId]: null }));
    }
  };

  const handleLogout = async (accountId: 1 | 2) => {
    setActionInProgress((prev) => ({ ...prev, [accountId]: 'logout' }));
    try {
      const result = await api.logoutClaudeAccount(accountId);
      setLoginStatuses((prev) => ({ ...prev, [accountId]: result.loginStatus }));
    } catch (err) {
      console.error(`Logout failed for account ${accountId}:`, err);
    } finally {
      setActionInProgress((prev) => ({ ...prev, [accountId]: null }));
    }
  };

  const refreshStatus = async () => {
    setLoginStatuses({ 1: null, 2: null });
    try {
      const resp = await api.fetchLoginStatus();
      setLoginStatuses(resp.loginStatuses);
    } catch {
      setLoginStatuses({});
    }
  };

  // Build login command hint for accounts that aren't logged in
  const notLoggedInAccounts = settings?.accounts.filter((acct) => {
    const status = loginStatuses[acct.id];
    return status && !status.loggedIn;
  }) ?? [];

  return (
    <>
      <div style={styles.overlay} onClick={onClose} />
      <div style={styles.modal}>
        <div style={styles.header}>
          <h3 style={styles.title}>Settings</h3>
          <button onClick={onClose} style={styles.closeBtn} title="Close">✕</button>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionLabelRow}>
            <span style={styles.sectionLabel}>Claude Account</span>
            <button onClick={refreshStatus} style={styles.refreshBtn} title="Refresh login status">↻</button>
          </div>

          {settings ? (
            <div style={styles.accountList}>
              {settings.accounts.map((acct) => {
                const isActive = acct.id === settings.activeAccount;
                const status = loginStatuses[acct.id];
                const isChecking = status === null && acct.id in loginStatuses;
                const action = actionInProgress[acct.id];

                return (
                  <div
                    key={acct.id}
                    style={{
                      ...styles.accountCard,
                      ...(isActive ? styles.accountCardActive : styles.accountCardInactive),
                    }}
                  >
                    <button
                      onClick={() => handleSwitch(acct.id)}
                      disabled={switching}
                      style={styles.accountBtn}
                    >
                      <div style={styles.accountBtnInner}>
                        <div style={styles.accountNameRow}>
                          <span style={styles.accountName}>{acct.name}</span>
                          {/* Status pill */}
                          {isChecking ? (
                            <span style={styles.statusPillChecking}>Checking…</span>
                          ) : status?.loggedIn ? (
                            <span style={styles.statusPillLoggedIn}>Logged in</span>
                          ) : status && !status.loggedIn ? (
                            <span style={styles.statusPillNotLoggedIn}>Not logged in</span>
                          ) : null}
                        </div>
                        <span style={styles.accountDir}>{acct.configDir}</span>
                        {/* Email + subscription when logged in */}
                        {status?.loggedIn && status.email && (
                          <span style={styles.accountEmail}>
                            {status.email}
                            {status.subscriptionType ? ` · ${status.subscriptionType}` : ''}
                          </span>
                        )}
                      </div>
                      <div style={styles.accountActions}>
                        {isActive && <span style={styles.activePill}>Active</span>}
                      </div>
                    </button>
                    {/* Login / Logout action buttons */}
                    <div style={styles.actionRow}>
                      {status?.loggedIn ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleLogout(acct.id); }}
                          disabled={!!action}
                          style={styles.logoutBtn}
                        >
                          {action === 'logout' ? 'Logging out…' : 'Log out'}
                        </button>
                      ) : status && !status.loggedIn ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleLogin(acct.id); }}
                          disabled={!!action}
                          style={styles.loginBtn}
                        >
                          {action === 'login' ? 'Logging in…' : 'Log in'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={styles.loading}>Loading…</div>
          )}
        </div>

        <div style={styles.note}>
          Switching accounts affects new messages only. Existing sessions continue with their original account.
        </div>

        {notLoggedInAccounts.length > 0 && (
          <div style={styles.hint}>
            Or log in via terminal:
            {notLoggedInAccounts.map((acct) => {
              // Account 1 uses default config dir (~/.claude), no env var needed
              const isDefault = acct.configDir === '~/.claude';
              const cmd = isDefault
                ? 'claude login'
                : `CLAUDE_CONFIG_DIR=${acct.configDir} claude login`;
              return (
                <div key={acct.id} style={styles.hintItem}>
                  <span style={styles.hintLabel}>{acct.name}:</span>
                  <code style={styles.code}>{cmd}</code>
                </div>
              );
            })}
          </div>
        )}
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
    width: 380,
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
  sectionLabelRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  refreshBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: 14,
    padding: '0 4px',
    borderRadius: 4,
  },
  accountList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  accountCard: {
    borderRadius: 'var(--radius-sm)',
    border: '1px solid',
    overflow: 'hidden',
  },
  accountCardActive: {
    background: 'rgba(26, 122, 60, 0.15)',
    borderColor: 'rgba(74, 186, 106, 0.4)',
  },
  accountCardInactive: {
    background: 'rgba(255, 255, 255, 0.04)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  accountBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '10px 12px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
  },
  accountBtnInner: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    flex: 1,
  },
  accountNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  accountName: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  accountDir: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    fontFamily: 'monospace',
  },
  accountEmail: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    marginTop: 2,
  },
  accountActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  activePill: {
    fontSize: 10,
    fontWeight: 700,
    color: '#4aba6a',
    background: 'rgba(74, 186, 106, 0.15)',
    borderRadius: 10,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
  },
  // Status pills
  statusPillChecking: {
    fontSize: 10,
    fontWeight: 600,
    color: '#999',
    background: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 10,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
  },
  statusPillLoggedIn: {
    fontSize: 10,
    fontWeight: 600,
    color: '#4aba6a',
    background: 'rgba(74, 186, 106, 0.12)',
    borderRadius: 10,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
  },
  statusPillNotLoggedIn: {
    fontSize: 10,
    fontWeight: 600,
    color: '#ef6461',
    background: 'rgba(239, 100, 97, 0.12)',
    borderRadius: 10,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
  },
  // Action row (login/logout buttons)
  actionRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: '0 12px 8px',
  },
  loginBtn: {
    fontSize: 11,
    fontWeight: 600,
    color: '#4aba6a',
    background: 'rgba(74, 186, 106, 0.12)',
    border: '1px solid rgba(74, 186, 106, 0.3)',
    borderRadius: 4,
    padding: '3px 10px',
    cursor: 'pointer',
  },
  logoutBtn: {
    fontSize: 11,
    fontWeight: 600,
    color: '#ef6461',
    background: 'rgba(239, 100, 97, 0.08)',
    border: '1px solid rgba(239, 100, 97, 0.2)',
    borderRadius: 4,
    padding: '3px 10px',
    cursor: 'pointer',
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
    marginBottom: 8,
    fontStyle: 'italic',
  },
  hint: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
    borderTop: '1px solid rgba(255, 255, 255, 0.06)',
    paddingTop: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  hintItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  hintLabel: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    fontWeight: 600,
  },
  code: {
    display: 'block',
    background: 'rgba(0,0,0,0.3)',
    borderRadius: 4,
    padding: '6px 8px',
    fontFamily: 'monospace',
    fontSize: 10,
    color: '#4aba6a',
    wordBreak: 'break-all',
  },
};
