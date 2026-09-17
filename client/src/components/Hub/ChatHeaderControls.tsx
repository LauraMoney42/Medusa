import { useEffect } from 'react';
import { fetchSettings, setProvider } from '../../api';
import { useProviderStore } from '../../stores/providerStore';

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

  // Provider lives in the shared providerStore (not local state) so that
  // switching it here is immediately reflected in the bottom-bar model
  // picker in MedusaChat.tsx too, instead of the two disagreeing until a
  // reload re-runs each component's own fetchSettings() call.
  const provider = useProviderStore((s) => s.activeProviderId);
  const setProviderState = useProviderStore((s) => s.setActiveProviderId);
  const providers = useProviderStore((s) => s.providers);
  const fetchProviderList = useProviderStore((s) => s.fetchProviders);

  useEffect(() => {
    void fetchProviderList();
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
  }, [fetchProviderList, setProviderState]);

  const activeId = resolveActiveId(sessions, activeSessionId);

  const handleProviderChange = async (
    e: React.ChangeEvent<HTMLSelectElement>,
  ) => {
    const value = e.target.value;
    try {
      await setProvider(value);
    } catch {
      // Ignore errors; still reflect the user's selection locally.
    }
    setProviderState(value);
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
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}
