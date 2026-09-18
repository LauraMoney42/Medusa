import { useCallback, useEffect, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useProviderStore } from '../../stores/providerStore';
import { fetchSkills, type SkillInfo } from '../../api';

/**
 * Tools: a management view for what this chat can reach.
 *
 * The engine and provider rows are live (they come from the session and the
 * provider registry). The MCP tool list mirrors the `medusa` MCP server's
 * surface in server/src/mcp/tools.ts; the server has no route that enumerates
 * it yet, so it is a static list here and switches to a fetch once one exists.
 * Skills come from GET /api/skills. Rules are placeholders: the real Medusa
 * layer (`~/.medusa/rules/*.md`, workstream S13) lands later, so the toggles
 * only persist to localStorage for now and drive nothing server-side.
 */

interface ToggleItem {
  id: string;
  label: string;
  detail: string;
}

/** The `medusa` MCP server's tool surface (server/src/mcp/tools.ts). */
const MCP_TOOLS: ToggleItem[] = [
  { id: 'spawn_agent', label: 'spawn_agent', detail: 'Start a subagent on a focused task' },
  { id: 'agent_status', label: 'agent_status', detail: 'Check a running subagent' },
  { id: 'agent_result', label: 'agent_result', detail: 'Collect a subagent result' },
  { id: 'list_agents', label: 'list_agents', detail: 'List this chat’s subagents' },
  { id: 'cancel_agent', label: 'cancel_agent', detail: 'Stop a running subagent' },
];

/** Placeholder rule files until the Medusa layer ships (addendum, S13). */
const RULES: ToggleItem[] = [
  { id: 'adhd-mode', label: 'ADHD mode', detail: 'Short, action-first replies' },
  { id: 'terse', label: 'Terse', detail: 'No preamble, no summaries' },
  { id: 'tests-first', label: 'Tests first', detail: 'Write the failing test before the fix' },
];

const STORE_KEY = 'medusa.tools.enabled';

/** Toggles are per chat, so one project can run a rule another does not. */
function loadEnabled(): Record<string, Record<string, boolean>> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, Record<string, boolean>>)
      : {};
  } catch {
    return {};
  }
}

export default function ToolsView() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const session = sessions.find((s) => s.id === activeSessionId);
  const providers = useProviderStore((s) => s.providers);
  const fetchProviderList = useProviderStore((s) => s.fetchProviders);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsReady, setSkillsReady] = useState(true);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void fetchProviderList();
    fetchSkills()
      .then((r) => {
        setSkills(r.skills);
        setSkillsReady(r.ready);
      })
      .catch(() => setSkillsReady(false));
  }, [fetchProviderList]);

  const scope = activeSessionId ?? 'global';
  useEffect(() => {
    setEnabled(loadEnabled()[scope] ?? {});
  }, [scope]);

  const toggle = useCallback(
    (id: string, fallback: boolean) => {
      setEnabled((prev) => {
        const next = { ...prev, [id]: !(prev[id] ?? fallback) };
        const all = loadEnabled();
        all[scope] = next;
        localStorage.setItem(STORE_KEY, JSON.stringify(all));
        return next;
      });
    },
    [scope],
  );

  const providerLabel =
    providers.find((p) => p.id === (session?.providerId ?? 'claude'))?.displayName ??
    session?.providerId ??
    'claude';

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Tools</h2>
        <span style={styles.subtitle}>
          {session ? session.name : 'No chat selected'}
        </span>
      </div>

      <div style={styles.body}>
        <section style={styles.section}>
          <span style={styles.sectionLabel}>This chat</span>
          <div style={styles.card}>
            <Row label="Engine" value={session?.engineId ?? 'claude'} />
            <Row label="Provider" value={providerLabel} />
            <Row label="Model" value={session?.model ?? 'Auto'} />
            <Row label="Folder" value={session?.workingDir ?? 'Not set'} mono />
          </div>
        </section>

        <section style={styles.section}>
          <span style={styles.sectionLabel}>Medusa MCP tools</span>
          <div style={styles.card}>
            {MCP_TOOLS.map((t) => (
              <ToggleRow
                key={t.id}
                item={t}
                on={enabled[t.id] ?? true}
                onToggle={() => toggle(t.id, true)}
              />
            ))}
          </div>
        </section>

        <section style={styles.section}>
          <span style={styles.sectionLabel}>Skills</span>
          <div style={styles.card}>
            {skills.length === 0 ? (
              <p style={styles.hint}>
                {skillsReady ? 'No skills installed.' : 'Skill index unavailable.'}
              </p>
            ) : (
              skills.map((s) => (
                <ToggleRow
                  key={s.slug}
                  item={{ id: `skill:${s.slug}`, label: s.name, detail: s.description }}
                  on={enabled[`skill:${s.slug}`] ?? false}
                  onToggle={() => toggle(`skill:${s.slug}`, false)}
                />
              ))
            )}
          </div>
        </section>

        <section style={styles.section}>
          <span style={styles.sectionLabel}>Rules</span>
          <div style={styles.card}>
            {RULES.map((r) => (
              <ToggleRow
                key={r.id}
                item={r}
                on={enabled[r.id] ?? false}
                onToggle={() => toggle(r.id, false)}
              />
            ))}
            <p style={styles.hint}>
              Rules are placeholders. They start composing into the system prompt when
              the Medusa persona layer ships.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={styles.infoRow}>
      <span style={styles.infoLabel}>{label}</span>
      <span
        style={{
          ...styles.infoValue,
          fontFamily: mono ? 'var(--font-mono)' : 'inherit',
        }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function ToggleRow({
  item,
  on,
  onToggle,
}: {
  item: ToggleItem;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={styles.toggleRow}>
      <div style={styles.toggleText}>
        <span style={styles.toggleLabel}>{item.label}</span>
        <span style={styles.toggleDetail}>{item.detail}</span>
      </div>
      <button
        onClick={onToggle}
        role="switch"
        aria-checked={on}
        aria-label={item.label}
        style={{
          ...styles.toggle,
          background: on ? 'var(--accent)' : 'rgba(255,255,255,0.14)',
        }}
      >
        <span
          style={{
            ...styles.knob,
            transform: on ? 'translateX(14px)' : 'translateX(0)',
          }}
        />
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--glass-bg-heavy)',
    minWidth: 0,
    minHeight: 0,
    height: '100%',
  },
  header: {
    padding: '14px 20px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
  },
  title: { fontSize: 16, fontWeight: 700, color: '#4aba6a', margin: 0 },
  subtitle: { fontSize: 12, color: 'var(--text-muted)' },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '18px 20px 40px',
    maxWidth: 720,
    width: '100%',
  },
  section: { marginBottom: 22 },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.09em',
    display: 'block',
    marginBottom: 8,
  },
  card: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '4px 12px',
  },
  infoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '9px 0',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  infoLabel: { fontSize: 12, color: 'var(--text-secondary)', width: 76, flexShrink: 0 },
  infoValue: {
    fontSize: 12,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '9px 0',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  toggleText: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 },
  toggleLabel: { fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 600 },
  toggleDetail: {
    fontSize: 11,
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  toggle: {
    width: 32,
    height: 18,
    borderRadius: 9,
    border: 'none',
    cursor: 'pointer',
    padding: 2,
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    transition: 'background 0.15s',
  },
  knob: {
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: '#fff',
    transition: 'transform 0.15s',
  },
  hint: {
    fontSize: 11,
    color: 'var(--text-muted)',
    lineHeight: 1.6,
    margin: '10px 0',
  },
};
