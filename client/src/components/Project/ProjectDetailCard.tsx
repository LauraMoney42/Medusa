import { useState } from 'react';
import type { ProjectSummary } from '../../types/project';

// Priority badge colors — spec: P0 red, P1 orange, P2 yellow, P3 gray
const PRIORITY_COLOR: Record<string, string> = {
  P0: '#c0392b',
  P1: '#e67e22',
  P2: '#d4ac0d',
  P3: '#7f8c8d',
};

const PRIORITY_BG: Record<string, string> = {
  P0: 'rgba(192, 57, 43, 0.15)',
  P1: 'rgba(230, 126, 34, 0.14)',
  P2: 'rgba(212, 172, 13, 0.12)',
  P3: 'rgba(127, 140, 141, 0.12)',
};

interface Props {
  project: ProjectSummary;
  isHighlighted: boolean;
  onEdit: () => void;
}

/** Strip leading "P0: " / "P1: " prefix since we show the priority badge separately */
function stripPriorityPrefix(title: string): string {
  return title.replace(/^P\d+:\s*/i, '');
}

export default function ProjectDetailCard({ project, isHighlighted, onEdit }: Props) {
  const isComplete = project.status === 'complete';
  // Active projects expand by default; complete ones collapse to reduce noise
  const [expanded, setExpanded] = useState(!isComplete);

  const done = project.assignments.filter((a) => a.status === 'done');
  const inProgress = project.assignments.filter((a) => a.status === 'in_progress');
  const todo = project.assignments.filter((a) => a.status === 'pending');
  const total = project.assignments.length;
  const progressPct = total === 0 ? 0 : Math.round((done.length / total) * 100);

  // Unique owners, preserving first-seen order
  const uniqueOwners = [...new Set(project.assignments.map((a) => a.owner))];

  return (
    <div
      style={{
        ...styles.card,
        borderColor: isHighlighted
          ? 'rgba(74, 186, 106, 0.45)'
          : 'rgba(255, 255, 255, 0.08)',
        boxShadow: isHighlighted
          ? '0 0 0 2px rgba(74, 186, 106, 0.07)'
          : 'none',
      }}
    >
      {/* ── Header (always visible, click to toggle) ── */}
      <div style={styles.header} onClick={() => setExpanded((e) => !e)}>
        <div style={styles.headerLeft}>
          <span style={styles.toggle}>{expanded ? '▾' : '▸'}</span>

          {project.priority && (
            <span
              style={{
                ...styles.priorityBadge,
                background: PRIORITY_BG[project.priority] ?? 'rgba(85,85,85,0.12)',
                color: PRIORITY_COLOR[project.priority] ?? '#888',
              }}
            >
              {project.priority}
            </span>
          )}

          <span style={styles.title}>{stripPriorityPrefix(project.title)}</span>
        </div>

        <div style={styles.headerRight}>
          <span
            style={{
              ...styles.statusBadge,
              background: isComplete
                ? 'rgba(255,255,255,0.05)'
                : 'rgba(26, 122, 60, 0.12)',
              color: isComplete ? 'var(--text-muted)' : '#4aba6a',
            }}
          >
            {isComplete ? 'Complete' : 'Active'}
          </span>

          <button
            style={styles.editBtn}
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            title="Edit project"
          >
            Edit
          </button>
        </div>
      </div>

      {/* ── Expanded body ── */}
      {expanded && (
        <div style={styles.body}>
          {/* Assigned bots */}
          {uniqueOwners.length > 0 && (
            <div style={styles.metaRow}>
              <span style={styles.metaLabel}>Assigned</span>
              <span style={styles.metaValue}>{uniqueOwners.join(', ')}</span>
            </div>
          )}

          {/* Progress bar */}
          {total > 0 && (
            <div style={styles.progressRow}>
              <div style={styles.progressTrack}>
                <div
                  style={{
                    ...styles.progressFill,
                    width: `${progressPct}%`,
                  }}
                />
              </div>
              <span style={styles.progressLabel}>
                <span style={{ color: '#4aba6a' }}>{done.length} done</span>
                {inProgress.length > 0 && (
                  <span style={{ color: 'var(--warning)' }}>
                    {' '}· {inProgress.length} in progress
                  </span>
                )}
                {todo.length > 0 && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}· {todo.length} todo
                  </span>
                )}
              </span>
            </div>
          )}

          {/* Task groups — order: DONE → IN PROGRESS → TODO (matches spec mockup) */}
          {done.length > 0 && (
            <TaskSection
              emoji="✅"
              label="DONE"
              tasks={done.map((a) => ({ task: a.task, owner: a.owner }))}
              color="var(--text-muted)"
              muted
            />
          )}

          {inProgress.length > 0 && (
            <TaskSection
              emoji="🔄"
              label="IN PROGRESS"
              tasks={inProgress.map((a) => ({ task: a.task, owner: a.owner }))}
              color="var(--warning)"
            />
          )}

          {todo.length > 0 && (
            <TaskSection
              emoji="📋"
              label="TODO"
              tasks={todo.map((a) => ({ task: a.task, owner: a.owner }))}
              color="var(--text-secondary)"
            />
          )}

          {total === 0 && (
            <p style={styles.noTasks}>No tasks assigned yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Task section (one status group) ──

function TaskSection({
  emoji,
  label,
  tasks,
  color,
  muted = false,
}: {
  emoji: string;
  label: string;
  tasks: { task: string; owner: string }[];
  color: string;
  muted?: boolean;
}) {
  return (
    <div style={styles.taskSection}>
      <div style={{ ...styles.taskSectionHeader, color }}>{emoji} {label}</div>
      {tasks.map((t, i) => (
        <div key={i} style={{ ...styles.taskItem, opacity: muted ? 0.55 : 1 }}>
          <span style={styles.taskBullet}>·</span>
          <span style={styles.taskText}>{t.task}</span>
          <span style={styles.taskOwner}>{t.owner}</span>
        </div>
      ))}
    </div>
  );
}

// ── Styles ──

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: '#1e1e20',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 8,
    overflow: 'hidden',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '11px 14px',
    cursor: 'pointer',
    userSelect: 'none',
    gap: 8,
  } as React.CSSProperties,
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    minWidth: 0,
    flex: 1,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  toggle: {
    fontSize: 10,
    color: 'var(--text-muted)',
    width: 12,
    flexShrink: 0,
  },
  priorityBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '1px 7px',
    borderRadius: 10,
    flexShrink: 0,
    letterSpacing: '0.02em',
  },
  title: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  statusBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  } as React.CSSProperties,
  editBtn: {
    fontSize: 11,
    fontWeight: 500,
    padding: '2px 9px',
    borderRadius: 5,
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.09)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  body: {
    padding: '12px 14px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    borderTop: '1px solid rgba(255,255,255,0.05)',
  } as React.CSSProperties,
  metaRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
  },
  metaLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    width: 60,
    flexShrink: 0,
    paddingTop: 1,
  } as React.CSSProperties,
  metaValue: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  progressRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  progressTrack: {
    flex: 1,
    height: 5,
    background: 'rgba(255,255,255,0.08)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    background: '#4aba6a',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  },
  progressLabel: {
    fontSize: 11,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  } as React.CSSProperties,
  taskSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  taskSectionHeader: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.05em',
    marginBottom: 2,
  },
  taskItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 5,
    paddingLeft: 2,
  },
  taskBullet: {
    color: 'var(--text-muted)',
    flexShrink: 0,
    lineHeight: '17px',
    fontSize: 13,
  },
  taskText: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    flex: 1,
    lineHeight: 1.45,
  } as React.CSSProperties,
  taskOwner: {
    fontSize: 10,
    color: 'var(--text-muted)',
    flexShrink: 0,
    fontStyle: 'italic',
    paddingTop: 1,
  },
  noTasks: {
    fontSize: 12,
    color: 'var(--text-muted)',
    margin: 0,
    fontStyle: 'italic',
  },
};
