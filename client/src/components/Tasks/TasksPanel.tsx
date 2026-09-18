import { useEffect, useMemo, useState } from 'react';
import { getSocket } from '../../socket';
import { useSubagentStore } from '../../stores/subagentStore';
import { useTasksStore, buildTaskRows, isRunning, type TaskRow } from '../../stores/tasksStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useVoiceStore } from '../../stores/voiceStore';

const RECENT_LIMIT = 20;

const STATUS_COLOR: Record<string, string> = {
  queued: 'var(--text-muted)',
  running: 'var(--accent)',
  active: 'var(--accent)',
  done: 'var(--text-secondary)',
  error: 'var(--danger)',
  cancelled: 'var(--text-muted)',
};

const KIND_LABEL: Record<TaskRow['kind'], string> = {
  subagent: 'Subagent',
  followup: 'Follow-up queued',
  voice: 'Voice turn',
};

function formatElapsed(ms: number): string {
  if (ms < 1000) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** Ticks once a second while a row is still open; freezes once it ends. */
function useElapsed(row: TaskRow): string {
  const open = isRunning(row);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!open) {
    if (row.endedAt) {
      return formatElapsed(new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime());
    }
    return '';
  }
  return formatElapsed(now - new Date(row.startedAt).getTime());
}

/**
 * A persistent view of everything Medusa is doing in the background, across
 * every chat: running subagents, subagents whose result is queued as a
 * follow-up turn, and the active voice turn. Lives as a third tab in the
 * right panel (RightPanel.tsx), next to Browser and Simulator.
 */
export default function TasksPanel() {
  const subagentsById = useSubagentStore((s) => s.byId);
  const hydrated = useTasksStore((s) => s.hydrated);
  const hydratedOnce = useTasksStore((s) => s.hydratedOnce);
  const hydrate = useTasksStore((s) => s.hydrate);
  const followupQueued = useTasksStore((s) => s.followupQueued);
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const setActiveView = useSessionStore((s) => s.setActiveView);
  const voiceState = useVoiceStore((s) => s.state);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const [recentOpen, setRecentOpen] = useState(true);

  useEffect(() => {
    if (!hydratedOnce) void hydrate();
  }, [hydratedOnce, hydrate]);

  const rows = useMemo(
    () =>
      buildTaskRows({
        subagentsById,
        hydrated,
        followupQueued,
        sessions,
        voiceState,
        activeSessionId,
      }),
    [subagentsById, hydrated, followupQueued, sessions, voiceState, activeSessionId],
  );

  const running = rows.filter(isRunning);
  const finished = rows
    .filter((r) => !isRunning(r))
    .sort((a, b) => new Date(b.endedAt ?? b.startedAt).getTime() - new Date(a.endedAt ?? a.startedAt).getTime())
    .slice(0, RECENT_LIMIT);

  const jumpTo = (row: TaskRow) => {
    if (!row.sessionId) return;
    setActiveSession(row.sessionId);
    setActiveView('chat');
    if (row.anchorId) {
      // The chat column mounts on the next tick; wait a frame before scrolling.
      requestAnimationFrame(() => {
        setTimeout(() => {
          document.getElementById(row.anchorId!)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
      });
    }
  };

  const stop = (row: TaskRow, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!row.agentId) return;
    getSocket().emit('subagent:cancel', { sessionId: row.sessionId, agentId: row.agentId });
  };

  if (rows.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>
          Nothing running. Medusa's subagents and follow-ups will show up here.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.scroll}>
        <Section title={`Running (${running.length})`}>
          {running.length === 0 ? (
            <div style={styles.sectionEmpty}>Nothing running right now.</div>
          ) : (
            running.map((row) => (
              <TaskRowView key={row.id} row={row} onJump={jumpTo} onStop={stop} />
            ))
          )}
        </Section>

        <Section
          title={`Recent (${finished.length})`}
          collapsible
          open={recentOpen}
          onToggle={() => setRecentOpen((o) => !o)}
        >
          {finished.length === 0 ? (
            <div style={styles.sectionEmpty}>Nothing finished yet.</div>
          ) : (
            finished.map((row) => (
              <TaskRowView key={row.id} row={row} onJump={jumpTo} onStop={stop} />
            ))
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  collapsible,
  open = true,
  onToggle,
}: {
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div style={styles.section}>
      <button
        onClick={collapsible ? onToggle : undefined}
        style={{ ...styles.sectionHeader, cursor: collapsible ? 'pointer' : 'default' }}
      >
        {collapsible && <span style={styles.chevron}>{open ? '▼' : '▶'}</span>}
        {title}
      </button>
      {(!collapsible || open) && <div style={styles.sectionBody}>{children}</div>}
    </div>
  );
}

function TaskRowView({
  row,
  onJump,
  onStop,
}: {
  row: TaskRow;
  onJump: (row: TaskRow) => void;
  onStop: (row: TaskRow, e: React.MouseEvent) => void;
}) {
  const elapsed = useElapsed(row);
  const color = STATUS_COLOR[row.status] ?? 'var(--text-muted)';

  return (
    <button style={styles.row} onClick={() => onJump(row)}>
      <div style={styles.rowTop}>
        <span style={styles.kind}>{KIND_LABEL[row.kind]}</span>
        <span style={styles.name}>{row.name}</span>
        <span style={{ ...styles.status, color }}>{row.status}</span>
      </div>
      <div style={styles.rowBottom}>
        <span style={styles.chat}>{row.chatTitle}</span>
        {row.engine && (
          <span style={styles.meta}>
            {row.engine}
            {row.model ? `/${row.model}` : ''}
          </span>
        )}
        {elapsed && <span style={styles.meta}>{elapsed}</span>}
        {row.agentId && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => onStop(row, e)}
            style={styles.stopBtn}
            title="Stop this task"
          >
            Stop
          </span>
        )}
      </div>
      {row.detail && <div style={styles.detail}>{row.detail}</div>}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minWidth: 0,
    overflow: 'hidden',
  },
  scroll: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '8px 10px',
  },
  empty: {
    margin: 'auto',
    padding: 24,
    textAlign: 'center',
    color: 'var(--text-muted)',
    fontSize: 13,
    lineHeight: 1.5,
  },
  section: {
    marginBottom: 12,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    background: 'transparent',
    border: 'none',
    padding: '4px 2px',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-muted)',
    textAlign: 'left',
  },
  chevron: {
    fontSize: 9,
  },
  sectionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 4,
  },
  sectionEmpty: {
    fontSize: 12,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
    padding: '4px 2px',
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    width: '100%',
    textAlign: 'left',
    background: 'rgba(0, 0, 0, 0.25)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 'var(--radius-sm)',
    padding: '8px 10px',
    cursor: 'pointer',
    color: 'inherit',
  },
  rowTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  kind: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--text-muted)',
    flexShrink: 0,
  },
  name: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  status: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    flexShrink: 0,
  },
  rowBottom: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  chat: {
    fontSize: 11,
    color: 'var(--text-secondary)',
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
  stopBtn: {
    marginLeft: 'auto',
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
  detail: {
    fontSize: 11,
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};
