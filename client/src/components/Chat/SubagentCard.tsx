import { useEffect, useState } from 'react';
import { getSocket } from '../../socket';
import { useSubagentStore, type Subagent } from '../../stores/subagentStore';
import ToolUseBlock from './ToolUseBlock';

interface SubagentCardProps {
  /** The `sa_...` id from `subagent:start`. */
  agentId: string;
  /** Rendered in place of the parent's `spawn_agent` tool card. */
  sessionId: string;
}

/** Collapsed header colour per status, matching the theme variables. */
const STATUS_COLOR: Record<Subagent['status'], string> = {
  queued: 'var(--text-muted)',
  running: 'var(--accent)',
  done: 'var(--text-secondary)',
  error: 'var(--danger)',
  cancelled: 'var(--text-muted)',
};

const STATUS_GLYPH: Record<Subagent['status'], string> = {
  queued: '…',
  running: '•',
  done: '✓',
  error: '✕',
  cancelled: '⊘',
};

function formatElapsed(ms: number): string {
  if (ms < 1000) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/**
 * Live elapsed time. Ticks once a second while the run is open and freezes on
 * the server's reported duration once it ends, so the card never disagrees
 * with the Activity Log about how long a subagent took.
 */
function useElapsed(agent: Subagent): string {
  const isOpen = agent.status === 'running' || agent.status === 'queued';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isOpen]);

  if (!isOpen) {
    if (agent.durationMs != null) return formatElapsed(agent.durationMs);
    if (agent.endedAt) {
      return formatElapsed(
        new Date(agent.endedAt).getTime() - new Date(agent.startedAt).getTime(),
      );
    }
    return '';
  }
  return formatElapsed(now - new Date(agent.startedAt).getTime());
}

/**
 * The Medusa-managed subagent card (spec E.4). Collapsed by default; expands
 * to the subagent's own stream, its tool cards, and the final result text.
 */
export default function SubagentCard({ agentId, sessionId }: SubagentCardProps) {
  const agent = useSubagentStore((s) => s.byId[agentId]);
  const [expanded, setExpanded] = useState(false);

  if (!agent) return null;
  return <SubagentCardBody agent={agent} sessionId={sessionId} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />;
}

function SubagentCardBody({
  agent,
  sessionId,
  expanded,
  onToggle,
}: {
  agent: Subagent;
  sessionId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const elapsed = useElapsed(agent);
  const isOpen = agent.status === 'running' || agent.status === 'queued';
  const isError = agent.status === 'error';
  const color = STATUS_COLOR[agent.status];

  const stop = (e: React.MouseEvent) => {
    e.stopPropagation();
    getSocket().emit('subagent:cancel', { sessionId, agentId: agent.id });
  };

  return (
    <div
      id={`subagent-card-${agent.id}`}
      style={{
        ...styles.container,
        border: isError
          ? '1px solid rgba(192, 57, 43, 0.45)'
          : '1px solid rgba(255, 255, 255, 0.08)',
      }}
    >
      <div style={styles.headerRow}>
        <button onClick={onToggle} style={styles.header}>
          <span style={styles.chevron}>{expanded ? '▼' : '▶'}</span>
          <span style={{ ...styles.glyph, color }}>{STATUS_GLYPH[agent.status]}</span>
          <span style={styles.name}>{agent.name}</span>
          <span style={styles.meta}>
            {agent.engine}
            {agent.model ? `/${agent.model}` : ''}
          </span>
          <span style={styles.meta}>
            {agent.tools.length} tool{agent.tools.length === 1 ? '' : 's'}
          </span>
          <span style={{ ...styles.status, color }}>{agent.status}</span>
          {elapsed && <span style={styles.meta}>{elapsed}</span>}
        </button>
        {isOpen && (
          <button onClick={stop} style={styles.stopBtn} title="Stop this subagent">
            Stop
          </button>
        )}
      </div>

      {expanded && (
        <div style={styles.body}>
          {agent.task && (
            <div style={styles.section}>
              <div style={styles.label}>Task</div>
              <div style={styles.task}>{agent.task}</div>
            </div>
          )}

          {agent.tools.length > 0 && (
            <div style={styles.tools}>
              {agent.tools.map((tool, i) => (
                <ToolUseBlock key={tool.id ?? i} tool={tool} />
              ))}
            </div>
          )}

          {agent.text && (
            <div style={styles.section}>
              <div style={styles.label}>{isOpen ? 'Output' : 'Result'}</div>
              <pre style={styles.result}>{agent.text}</pre>
              {agent.truncated && (
                <div style={styles.note}>
                  Result clipped; the full transcript is on disk.
                </div>
              )}
            </div>
          )}

          {agent.error && (
            <div style={styles.section}>
              <div style={styles.label}>Error</div>
              <pre style={{ ...styles.result, color: 'var(--danger)' }}>{agent.error}</pre>
            </div>
          )}

          {isOpen && !agent.text && agent.tools.length === 0 && (
            <div style={{ ...styles.section, ...styles.pending }}>Starting...</div>
          )}

          {!isOpen && agent.usage.costUsd > 0 && (
            <div style={styles.cost}>${agent.usage.costUsd.toFixed(4)}</div>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: 'rgba(0, 0, 0, 0.25)',
    borderRadius: 'var(--radius-sm)',
    overflow: 'hidden',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
    padding: '6px 10px',
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: 13,
    cursor: 'pointer',
  },
  chevron: {
    fontSize: 10,
    width: 14,
    flexShrink: 0,
  },
  glyph: {
    fontSize: 12,
    flexShrink: 0,
  },
  name: {
    fontWeight: 600,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--text-muted)',
    flexShrink: 0,
  },
  status: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    flexShrink: 0,
  },
  stopBtn: {
    marginRight: 8,
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--danger)',
    background: 'rgba(192, 57, 43, 0.12)',
    border: '1px solid rgba(192, 57, 43, 0.3)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  body: {
    padding: '0 10px 8px 24px',
  },
  section: {
    marginTop: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 2,
  },
  task: {
    fontSize: 12,
    lineHeight: 1.4,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap',
  },
  tools: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 6,
  },
  result: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    lineHeight: 1.4,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
    maxHeight: 320,
    overflowY: 'auto',
  },
  note: {
    marginTop: 4,
    fontSize: 11,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
  pending: {
    fontSize: 12,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
  cost: {
    marginTop: 6,
    fontSize: 11,
    color: 'var(--text-muted)',
    textAlign: 'right',
  },
};
