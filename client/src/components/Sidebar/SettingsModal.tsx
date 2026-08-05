import { useState, useEffect, useRef } from 'react';
import * as api from '../../api';
import type { SettingsResponse, OneNoteStatus, OneNoteDeviceCode, HeadroomStatus, TtsStatus } from '../../api';
import { useTtsStore } from '../../stores/ttsStore';

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [working, setWorking] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // OneNote state
  const [oneNoteStatus, setOneNoteStatus] = useState<OneNoteStatus | null>(null);
  const [deviceCode, setDeviceCode] = useState<OneNoteDeviceCode | null>(null);
  const [authPolling, setAuthPolling] = useState(false);

  // Headroom compression status — polled live while the modal is open.
  const [headroom, setHeadroom] = useState<HeadroomStatus | null>(null);

  // Voice (TTS) settings — prefs come from the shared store.
  const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null);
  const speak = useTtsStore((s) => s.speak);
  const setSpeak = useTtsStore((s) => s.setSpeak);
  const voice = useTtsStore((s) => s.voice);
  const setVoice = useTtsStore((s) => s.setVoice);
  const speed = useTtsStore((s) => s.speed);
  const setSpeed = useTtsStore((s) => s.setSpeed);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      api.fetchHeadroomStatus()
        .then((s) => { if (!cancelled) setHeadroom(s); })
        .catch(() => { if (!cancelled) setHeadroom(null); });
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    api.fetchSettings().then(setSettings).catch(console.error);
    api.fetchOneNoteStatus().then(setOneNoteStatus).catch(console.error);

    if (deviceCode) {
      setAuthPolling(true);
      const id = setInterval(() => {
        api.fetchOneNoteStatus().then((s) => {
          setOneNoteStatus(s);
          if (s.status === 'connected') {
            setDeviceCode(null);
            setAuthPolling(false);
            clearInterval(id);
          }
        }).catch(console.error);
      }, 5000);
      return () => clearInterval(id);
    }
  }, [deviceCode]);

  const handleLogin = async (provider: 'claude' | 'kimi') => {
    setWorking(true);
    try {
      const updated = await api.setProvider(provider);
      setSettings(updated);
      setShowPicker(false);
    } catch (err) {
      console.error('Login failed:', err);
      alert(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setWorking(false);
    }
  };

  const handleLogout = async () => {
    setWorking(true);
    try {
      const result = await api.logoutProvider();
      setSettings(result.settings);
    } catch (err) {
      console.error('Logout failed:', err);
    } finally {
      setWorking(false);
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

  const handleConnectOneNote = async () => {
    try {
      const dc = await api.startOneNoteAuth();
      setDeviceCode(dc);
    } catch (err) {
      console.error('[onenote] connect failed:', err);
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

  useEffect(() => {
    api.fetchTtsStatus().then(setTtsStatus).catch(() => setTtsStatus(null));
  }, []);

  const handleTestVoice = async () => {
    try {
      const url = await api.synthesizeSpeech('Hi, this is how I sound.', voice, speed);
      if (testAudioRef.current) testAudioRef.current.pause();
      const audio = new Audio(url);
      testAudioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (err) {
      console.error('Voice test failed:', err);
      alert('Voice test failed — is the TTS server running?');
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

        {/* Provider Login */}
        <div style={styles.section}>
          <span style={styles.sectionLabel}>Account</span>

          {settings ? (
            <div style={styles.accountCard}>
              <div style={styles.accountStatus}>
                {settings.activeProvider ? (
                  <span style={styles.statusTextOk}>
                    Using {settings.activeProvider === 'claude' ? 'Claude' : 'Kimi'}
                  </span>
                ) : (
                  <span style={styles.statusTextErr}>Not logged in</span>
                )}
              </div>

              {showPicker ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                  <span style={{ ...styles.statusText, fontSize: 11, marginBottom: 4 }}>
                    Choose a provider:
                  </span>
                  <button
                    onClick={() => handleLogin('claude')}
                    disabled={working}
                    style={styles.actionBtnPrimary}
                  >
                    {working ? 'Opening…' : 'Claude'}
                  </button>
                  <button
                    onClick={() => handleLogin('kimi')}
                    disabled={working}
                    style={styles.actionBtnPrimary}
                  >
                    {working ? 'Opening…' : 'Kimi'}
                  </button>
                  <button
                    onClick={() => setShowPicker(false)}
                    style={styles.actionBtn}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={styles.accountActions}>
                  <button
                    onClick={() => setShowPicker(true)}
                    disabled={working}
                    style={styles.actionBtnPrimary}
                  >
                    {working ? 'Working…' : 'Login'}
                  </button>
                  {settings.activeProvider && (
                    <button
                      onClick={handleLogout}
                      disabled={working}
                      style={styles.actionBtnDanger}
                    >
                      {working ? 'Working…' : 'Logout'}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div style={styles.loading}>Loading…</div>
          )}
        </div>

        {/* OneNote */}
        <div style={{ ...styles.section, marginTop: 8 }}>
          <span style={styles.sectionLabel}>OneNote Integration</span>

          <div style={styles.accountCard}>
            <div style={styles.accountHeader}>
              <span style={styles.accountName}>Microsoft OneNote</span>
              {oneNoteStatus?.status === 'connected' && (
                <span style={styles.activeBadge}>Connected</span>
              )}
              {(oneNoteStatus?.status === 'pending' || authPolling) && (
                <span style={{ ...styles.activeBadge, color: '#f0b429', background: 'rgba(240,180,41,0.15)' }}>
                  {authPolling ? 'Starting…' : 'Pending'}
                </span>
              )}
            </div>

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
                  {authPolling ? '⏳ Waiting… sign in then return here' : 'Sign in with your Microsoft account'}
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
                <button onClick={handleConnectOneNote} style={styles.actionBtnPrimary}>
                  Connect
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Headroom compression */}
        <div style={{ ...styles.section, marginTop: 8 }}>
          <span style={styles.sectionLabel}>Token Compression</span>

          <div style={styles.accountCard}>
            <div style={styles.accountHeader}>
              <span style={styles.accountName}>Headroom Proxy</span>
              {headroom?.ready ? (
                <span style={styles.activeBadge}>Active</span>
              ) : headroom?.enabled ? (
                <span style={{ ...styles.activeBadge, color: '#f0b429', background: 'rgba(240,180,41,0.15)' }}>
                  Starting…
                </span>
              ) : (
                <span style={{ ...styles.activeBadge, color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.08)' }}>
                  Off
                </span>
              )}
            </div>

            {headroom?.ready && headroom.stats ? (
              <div style={styles.statGrid}>
                <div style={styles.statItem}>
                  <span style={styles.statValue}>{Math.round(headroom.stats.avgCompressionPct)}%</span>
                  <span style={styles.statLabel}>avg compression</span>
                </div>
                <div style={styles.statItem}>
                  <span style={styles.statValue}>{headroom.stats.totalTokensSaved.toLocaleString()}</span>
                  <span style={styles.statLabel}>tokens saved</span>
                </div>
                <div style={styles.statItem}>
                  <span style={styles.statValue}>${headroom.stats.savedUsd.toFixed(2)}</span>
                  <span style={styles.statLabel}>est. saved</span>
                </div>
                <div style={styles.statItem}>
                  <span style={styles.statValue}>{headroom.stats.requestsCompressed}</span>
                  <span style={styles.statLabel}>reqs compressed</span>
                </div>
              </div>
            ) : (
              <p style={styles.headroomHint}>
                {headroom?.ready
                  ? 'Waiting for traffic — savings appear as bots handle large outputs.'
                  : headroom?.enabled
                    ? 'Proxy starting… routes bot traffic through Headroom to cut tokens.'
                    : 'Disabled. Set HEADROOM_ENABLED=true and restart to enable.'}
              </p>
            )}
          </div>
        </div>

        {/* Voice (TTS) */}
        {ttsStatus?.enabled && (
          <div style={{ ...styles.section, marginTop: 8 }}>
            <span style={styles.sectionLabel}>Voice</span>
            <div style={styles.accountCard}>
              <div style={styles.ttsRow}>
                <span style={styles.ttsLabel}>Speak replies aloud</span>
                <button
                  onClick={() => setSpeak(!speak)}
                  style={{ ...styles.toggle, ...(speak ? styles.toggleOn : {}) }}
                  title={speak ? 'On' : 'Off'}
                >
                  <span style={{ ...styles.toggleKnob, ...(speak ? styles.toggleKnobOn : {}) }} />
                </button>
              </div>

              <div style={styles.ttsField}>
                <label style={styles.ttsLabel}>Voice</label>
                <select value={voice} onChange={(e) => setVoice(e.target.value)} style={styles.ttsSelect}>
                  {ttsStatus.voices.map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </select>
              </div>

              <div style={styles.ttsField}>
                <label style={styles.ttsLabel}>Speed — {speed.toFixed(2)}×</label>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  style={styles.ttsSlider}
                />
              </div>

              <button onClick={handleTestVoice} style={{ ...styles.actionBtnPrimary, marginTop: 4 }}>
                ▶ Test voice
              </button>
            </div>
          </div>
        )}

        <button onClick={handleRestart} disabled={restarting} style={styles.restartBtn}>
          {restarting ? 'Restarting…' : 'Restart App'}
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
  accountCard: {
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    padding: '12px',
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
  statGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
    marginTop: 4,
  },
  statItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '8px 10px',
    background: 'rgba(74, 186, 106, 0.08)',
    border: '1px solid rgba(74, 186, 106, 0.18)',
    borderRadius: 6,
  },
  statValue: {
    fontSize: 16,
    fontWeight: 700,
    color: '#4aba6a',
    lineHeight: 1.1,
  },
  statLabel: {
    fontSize: 10,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  headroomHint: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    margin: '2px 0 0 0',
    lineHeight: 1.4,
  },
  ttsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  } as React.CSSProperties,
  ttsField: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginBottom: 10,
  } as React.CSSProperties,
  ttsLabel: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  ttsSelect: {
    width: '100%',
    background: '#232325',
    color: 'var(--text-primary)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12,
    cursor: 'pointer',
    outline: 'none',
  } as React.CSSProperties,
  ttsSlider: {
    width: '100%',
    accentColor: '#4aba6a',
    cursor: 'pointer',
  } as React.CSSProperties,
  toggle: {
    width: 38,
    height: 22,
    borderRadius: 11,
    background: 'rgba(255,255,255,0.15)',
    border: 'none',
    position: 'relative',
    cursor: 'pointer',
    transition: 'background 0.15s',
    padding: 0,
    flexShrink: 0,
  } as React.CSSProperties,
  toggleOn: {
    background: 'rgba(74,186,106,0.6)',
  },
  toggleKnob: {
    position: 'absolute',
    top: 2,
    left: 2,
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: '#fff',
    transition: 'left 0.15s',
  } as React.CSSProperties,
  toggleKnobOn: {
    left: 18,
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
