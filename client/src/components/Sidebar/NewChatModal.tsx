import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useProviderStore } from '../../stores/providerStore';

interface NewChatModalProps {
  onClose: () => void;
}

/** Engines Medusa knows how to spawn (mirrors ENGINE_IDS in server/src/routes/sessions.ts). */
const ENGINES: Array<{ id: string; label: string }> = [
  { id: 'claude', label: 'Claude CLI' },
  { id: 'kimi', label: 'Kimi CLI' },
  { id: 'code-puppy', label: 'Code Puppy (ACP)' },
];

const LAST_DIR_KEY = 'medusa.lastProjectDir';
const RECENT_DIRS_KEY = 'medusa.recentProjectDirs';
const MAX_RECENT = 6;

function readRecentDirs(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_DIRS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

function rememberDir(dir: string) {
  const next = [dir, ...readRecentDirs().filter((d) => d !== dir)].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(next));
  localStorage.setItem(LAST_DIR_KEY, dir);
}

/** Last path segment, so "~/Documents/GIT/Medusa" titles the chat "Medusa". */
function basename(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? dir;
}

/**
 * Native folder picker, when the Tauri shell exposes the dialog plugin.
 * Returns null in a plain browser (which cannot hand back a real filesystem
 * path), and the caller falls back to the text field. S9 adds the Rust side.
 */
async function pickFolderViaTauri(): Promise<string | null> {
  const tauri = (
    window as unknown as {
      __TAURI__?: { dialog?: { open?: (opts: unknown) => Promise<unknown> } };
    }
  ).__TAURI__;
  const open = tauri?.dialog?.open;
  if (typeof open !== 'function') return null;
  try {
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === 'string' && picked.trim() ? picked : null;
  } catch (err) {
    console.warn('[new-chat] Tauri folder picker failed, using the text field:', err);
    return null;
  }
}

export default function NewChatModal({ onClose }: NewChatModalProps) {
  const createSession = useSessionStore((s) => s.createSession);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const setActiveView = useSessionStore((s) => s.setActiveView);

  const providers = useProviderStore((s) => s.providers);
  const fetchProviderList = useProviderStore((s) => s.fetchProviders);
  const fetchProviderModels = useProviderStore((s) => s.fetchModels);
  const modelsByProvider = useProviderStore((s) => s.modelsByProvider);
  const globalProviderId = useProviderStore((s) => s.activeProviderId);

  const recentDirs = useMemo(readRecentDirs, []);
  const [workingDir, setWorkingDir] = useState(
    () => localStorage.getItem(LAST_DIR_KEY) ?? '',
  );
  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState(globalProviderId);
  const [engineId, setEngineId] = useState('claude');
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasNativePicker, setHasNativePicker] = useState(false);

  useEffect(() => {
    void fetchProviderList();
    setHasNativePicker(
      typeof (window as unknown as { __TAURI__?: { dialog?: { open?: unknown } } })
        .__TAURI__?.dialog?.open === 'function',
    );
  }, [fetchProviderList]);

  useEffect(() => {
    void fetchProviderModels(providerId);
  }, [providerId, fetchProviderModels]);

  // A model from the previous provider is meaningless after a switch.
  useEffect(() => {
    setModel('');
  }, [providerId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const models = modelsByProvider[providerId] ?? [];

  const handleBrowse = useCallback(async () => {
    const picked = await pickFolderViaTauri();
    if (picked) setWorkingDir(picked);
  }, []);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const dir = workingDir.trim();
      if (!dir) {
        setError('Pick a project folder for this chat.');
        return;
      }
      setBusy(true);
      setError('');
      try {
        const session = await createSession({
          workingDir: dir,
          // The title defaults to the folder basename; the server dedupes it.
          ...(name.trim() ? { name: name.trim() } : {}),
          providerId,
          engineId,
          ...(model ? { model } : {}),
        });
        rememberDir(dir);
        setActiveSession(session.id);
        setActiveView('chat');
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create the chat.');
      } finally {
        setBusy(false);
      }
    },
    [workingDir, name, providerId, engineId, model, createSession, setActiveSession, setActiveView, onClose],
  );

  return (
    <>
      <div style={styles.overlay} onClick={onClose} />
      <form style={styles.modal} onSubmit={handleSubmit}>
        <div style={styles.header}>
          <h3 style={styles.title}>New chat</h3>
          <button type="button" onClick={onClose} style={styles.closeBtn} title="Close">
            ✕
          </button>
        </div>

        <label style={styles.label}>Project folder</label>
        <div style={styles.folderRow}>
          <input
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="~/Documents/GIT/Medusa"
            style={styles.input}
            autoFocus
          />
          {hasNativePicker && (
            <button type="button" onClick={handleBrowse} style={styles.browseBtn}>
              Browse…
            </button>
          )}
        </div>

        {recentDirs.length > 0 && (
          <div style={styles.recentRow}>
            {recentDirs.map((dir) => (
              <button
                key={dir}
                type="button"
                onClick={() => setWorkingDir(dir)}
                style={styles.recentChip}
                title={dir}
              >
                {basename(dir)}
              </button>
            ))}
          </div>
        )}

        <label style={styles.label}>Title</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={workingDir ? basename(workingDir) : 'Folder name'}
          style={styles.input}
        />

        <div style={styles.grid}>
          <div>
            <label style={styles.label}>Provider</label>
            <select
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              style={styles.select}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Engine</label>
            <select
              value={engineId}
              onChange={(e) => setEngineId(e.target.value)}
              style={styles.select}
            >
              {ENGINES.map((en) => (
                <option key={en.id} value={en.id}>
                  {en.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label style={styles.label}>Model</label>
        <select value={model} onChange={(e) => setModel(e.target.value)} style={styles.select}>
          <option value="">Auto</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
              {m.cheap ? ' · cheap' : ''}
            </option>
          ))}
        </select>

        {error && <p style={styles.error}>{error}</p>}

        <div style={styles.actions}>
          <button type="button" onClick={onClose} style={styles.cancelBtn}>
            Cancel
          </button>
          <button type="submit" disabled={busy} style={styles.submitBtn}>
            {busy ? 'Creating…' : 'Create chat'}
          </button>
        </div>
      </form>
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
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-md, 12px)',
    padding: 20,
    boxShadow: 'var(--glass-shadow-modal)',
    width: 420,
    maxWidth: '92vw',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  title: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: 0 },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: 14,
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    marginTop: 8,
    display: 'block',
  },
  folderRow: { display: 'flex', gap: 6 },
  input: {
    flex: 1,
    width: '100%',
    padding: '8px 10px',
    fontSize: 13,
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(255,255,255,0.04)',
    color: 'var(--text-primary)',
    fontFamily: 'inherit',
  },
  browseBtn: {
    padding: '8px 12px',
    fontSize: 12,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-light)',
    background: 'rgba(255,255,255,0.06)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  recentRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  recentChip: {
    padding: '3px 9px',
    fontSize: 11,
    borderRadius: 999,
    border: '1px solid var(--border-glow)',
    background: 'rgba(26, 122, 60, 0.10)',
    color: '#4aba6a',
    cursor: 'pointer',
  },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  select: {
    width: '100%',
    padding: '8px 10px',
    fontSize: 13,
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--glass-bg)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  error: { fontSize: 12, color: 'var(--danger)', margin: '10px 0 0' },
  actions: { display: 'flex', gap: 8, marginTop: 18 },
  cancelBtn: {
    flex: 1,
    padding: '9px 12px',
    background: 'rgba(255,255,255,0.08)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
  },
  submitBtn: {
    flex: 1,
    padding: '9px 12px',
    background: 'var(--accent)',
    color: '#fff',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
  },
};
