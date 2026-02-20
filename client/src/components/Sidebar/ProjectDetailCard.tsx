import { useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { ProjectSummary, Assignment } from '../../types/project';

interface ProjectDetailCardProps {
  project: ProjectSummary;
}

// Priority badge colors per spec
const PRIORITY_COLORS: Record<string, string> = {
  P0: '#8B2E2E',  // red
  P1: '#8B5E2E',  // orange
  P2: '#7A7A2E',  // yellow
  P3: '#555',     // gray
};

const PRIORITY_BG: Record<string, string> = {
  P0: 'rgba(139, 46, 46, 0.18)',
  P1: 'rgba(139, 94, 46, 0.18)',
  P2: 'rgba(122, 122, 46, 0.18)',
  P3: 'rgba(85, 85, 85, 0.18)',
};

function groupAssignments(assignments: Assignment[]) {
  const inProgress = assignments.filter((a) => a.status === 'in_progress');
  const pending    = assignments.filter((a) => a.status === 'pending');
  const done       = assignments.filter((a) => a.status === 'done');
  return { inProgress, pending, done };
}

function uniqueOwners(assignments: Assignment[]): string[] {
  return [...new Set(assignments.map((a) => a.owner).filter(Boolean))];
}

export default function ProjectDetailCard({ project }: ProjectDetailCardProps) {
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const setActiveView = useSessionStore((s) => s.setActiveView);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeView = useSessionStore((s) => s.activeView);

  // All cards default collapsed — expand on click per spec
  const [expanded, setExpanded] = useState(false);

  const isSelected = activeView === 'project' && activeProjectId === project.id;

  const { inProgress, pending, done } = groupAssignments(project.assignments);
  const total = project.assignments.length;
  const doneCount = done.length;
  const progress = total > 0 ? (doneCount / total) * 100 : 0;
  const owners = uniqueOwners(project.assignments);

  const handleHeaderClick = () => {
    // Navigate to project + toggle expand
    setActiveProject(project.id);
    setActiveView('project');
    setExpanded((e) => !e);
  };

  return (
    <div
      style={{
        ...styles.card,
        background: isSelected
          ? 'rgba(255, 255, 255, 0.06)'
          : 'rgba(255, 255, 255, 0.02)',
        borderLeft: isSelected
          ? '2px solid var(--accent)'
          : '2px solid transparent',
      }}
    >
      {/* Header row — always visible */}
      <div style={styles.header} onClick={handleHeaderClick}>
        <div style={styles.headerLeft}>
          {project.priority && (
            <span
              style={{
                ...styles.priorityBadge,
                color: PRIORITY_COLORS[project.priority] ?? '#555',
                background: PRIORITY_BG[project.priority] ?? 'rgba(85,85,85,0.18)',
              }}
            >
              {project.priority}
            </span>
          )}
          <span style={styles.title}>{project.title}</span>
        </div>
        <div style={styles.headerRight}>
          <span
            style={{
              ...styles.statusDot,
              background: project.status === 'complete' ? '#2D6A4F' : '#B5873A',
            }}
          />
          <span style={styles.chevron}>{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={styles.detail}>
          {/* Assigned bots */}
          {owners.length > 0 && (
            <div style={styles.row}>
              <span style={styles.label}>Assigned</span>
              <span style={styles.owners}>{owners.join(', ')}</span>
            </div>
          )}

          {/* Progress bar */}
          {total > 0 && (
            <div style={styles.progressSection}>
              <div style={styles.progressBar}>
                <div
                  style={{
                    ...styles.progressFill,
                    width: `${progress}%`,
                  }}
                />
              </div>
              <span style={styles.progressLabel}>
                {doneCount}/{total} done
                {inProgress.length > 0 && ` · ${inProgress.length} in progress`}
                {pending.length > 0 && ` · ${pending.length} todo`}
              </span>
            </div>
          )}

          {/* IN PROGRESS tasks */}
          {inProgress.length > 0 && (
            <div style={styles.group}>
              <div style={styles.groupHeader}>
                <span style={styles.groupDotInProgress} />
                <span style={{ ...styles.groupLabel, color: 'var(--accent)' }}>
                  IN PROGRESS
                </span>
              </div>
              {inProgress.map((a) => (
                <TaskRow key={a.id} assignment={a} />
              ))}
            </div>
          )}

          {/* TODO tasks */}
          {pending.length > 0 && (
            <div style={styles.group}>
              <div style={styles.groupHeader}>
                <span style={styles.groupDotPending} />
                <span style={{ ...styles.groupLabel, color: 'var(--text-muted)' }}>
                  TODO
                </span>
              </div>
              {pending.map((a) => (
                <TaskRow key={a.id} assignment={a} />
              ))}
            </div>
          )}

          {/* DONE tasks */}
          {done.length > 0 && (
            <div style={styles.group}>
              <div style={styles.groupHeader}>
                <span style={styles.groupDotDone} />
                <span style={{ ...styles.groupLabel, color: '#2D6A4F' }}>
                  DONE
                </span>
              </div>
              {done.map((a) => (
                <TaskRow key={a.id} assignment={a} done />
              ))}
            </div>
          )}

          {total === 0 && (
            <span style={styles.emptyTasks}>No tasks yet</span>
          )}
        </div>
      )}
    </div>
  );
}

function TaskRow({ assignment, done = false }: { assignment: Assignment; done?: boolean }) {
  return (
    <div style={styles.taskRow}>
      <span style={styles.taskBullet}>{done ? '✓' : '·'}</span>
      <span
        style={{
          ...styles.taskText,
          color: done ? 'var(--text-muted)' : 'var(--text-secondary)',
          textDecoration: done ? 'line-through' : 'none',
          opacity: done ? 0.6 : 1,
        }}
      >
        {assignment.task}
      </span>
      {assignment.owner && (
        <span style={styles.taskOwner}>{assignment.owner}</span>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    borderRadius: 'var(--radius-sm)',
    margin: '2px 8px',
    transition: 'background 0.1s',
    cursor: 'default',
    overflow: 'hidden',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '7px 10px',
    cursor: 'pointer',
    gap: 6,
    userSelect: 'none',
  } as React.CSSProperties,
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
    flex: 1,
  } as React.CSSProperties,
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    flexShrink: 0,
  } as React.CSSProperties,
  priorityBadge: {
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '0.04em',
    padding: '2px 5px',
    borderRadius: 4,
    flexShrink: 0,
    lineHeight: 1.4,
  } as React.CSSProperties,
  title: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
  },
  chevron: {
    fontSize: 10,
    color: 'var(--text-muted)',
    lineHeight: 1,
  },
  detail: {
    padding: '0 10px 8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  } as React.CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
  } as React.CSSProperties,
  label: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--text-muted)',
    flexShrink: 0,
  },
  owners: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  progressSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  } as React.CSSProperties,
  progressBar: {
    height: 4,
    background: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    background: 'var(--accent)',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  } as React.CSSProperties,
  progressLabel: {
    fontSize: 10,
    color: 'var(--text-muted)',
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  } as React.CSSProperties,
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    marginBottom: 1,
  } as React.CSSProperties,
  groupLabel: {
    fontSize: 9,
    fontWeight: 800,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.07em',
  },
  groupDotInProgress: {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: 'var(--accent)',
    flexShrink: 0,
  },
  groupDotPending: {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: 'rgba(255, 255, 255, 0.25)',
    flexShrink: 0,
  },
  groupDotDone: {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: '#2D6A4F',
    flexShrink: 0,
  },
  taskRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 5,
    padding: '1px 0 1px 8px',
  } as React.CSSProperties,
  taskBullet: {
    fontSize: 10,
    color: 'var(--text-muted)',
    flexShrink: 0,
    lineHeight: 1.4,
  },
  taskText: {
    fontSize: 11,
    lineHeight: 1.4,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  taskOwner: {
    fontSize: 9,
    color: 'var(--text-muted)',
    flexShrink: 0,
    maxWidth: 60,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  emptyTasks: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
    padding: '2px 0',
  },
};
