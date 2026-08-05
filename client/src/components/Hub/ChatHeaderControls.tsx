import { useEffect, useState } from 'react';
import { fetchSettings, setProvider, setSessionModel } from '../../api';

interface ChatHeaderControlsProps {
  sessions: { id: string; name: string; model?: string }[];
  activeSessionId: string | null;
  onSelectAgent: (sessionId: string) => void;
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  select: {
    background: '#232325',
    color: 'var(--text-primary)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 'var(--radius-sm)',
    padding: '4px 8px',
    fontSize: 12,
    cursor: 'pointer',
    outline: 'none',
  },
};

/**
 * Resolve the effective active session id.
 * Prefers an explicitly-selected session; otherwise falls back to a session
 * named "medusa" (case-insensitive), then the first session, then ''.
 */
function resolveActiveId(
  sessions: ChatHeaderControlsProps['sessions'],
  activeSessionId: string | null,
): string {
  if (activeSessionId) return activeSessionId;
  const medusa = sessions.find((s) => s.name.toLowerCase() === 'medusa');
  if (medusa) return medusa.id;
  if (sessions.length > 0) return sessions[0].id;
  return '';
}

export default function ChatHeaderControls(props: ChatHeaderControlsProps) {
  const { sessions, activeSessionId, onSelectAgent } = props;

  // Provider comes from an async fetch, so it's the only piece kept in local
  // state. Agent value and model value derive from props on every render.
  const [provider, setProviderState] = useState<'claude' | 'kimi'>('claude');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await fetchSettings();
        if (!cancelled) {
          setProviderState(settings.activeProvider ?? 'claude');
        }
      } catch {
        // Ignore fetch errors; leave provider at its default.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeId = resolveActiveId(sessions, activeSessionId);
  const activeSession = sessions.find((s) => s.id === activeId);
  const modelValue = activeSession?.model ?? '';

  const handleProviderChange = async (
    e: React.ChangeEvent<HTMLSelectElement>,
  ) => {
    const value = e.target.value as 'claude' | 'kimi';
    try {
      await setProvider(value);
    } catch {
      // Ignore errors; still reflect the user's selection locally.
    }
    setProviderState(value);
  };

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (!activeId) return;
    void setSessionModel(activeId, e.target.value || null);
  };

  return (
    <div style={styles.row}>
      <select
        style={styles.select}
        value={activeId}
        onChange={(e) => onSelectAgent(e.target.value)}
        aria-label="Agent"
      >
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      <select
        style={styles.select}
        value={provider}
        onChange={handleProviderChange}
        aria-label="Provider"
      >
        <option value="claude">Anthropic</option>
        <option value="kimi">Kimi</option>
      </select>

      <select
        style={styles.select}
        value={modelValue}
        onChange={handleModelChange}
        disabled={!activeId}
        title="Model change applies after a server restart"
        aria-label="Model"
      >
        <option value="">Auto</option>
        <option value="haiku">Haiku</option>
        <option value="sonnet">Sonnet</option>
        <option value="opus">Opus</option>
        <option value="fable">Fable</option>
      </select>
    </div>
  );
}
