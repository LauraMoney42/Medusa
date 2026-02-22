import { useState, useEffect, useCallback } from 'react';
import { useQuickTaskStore } from '../../stores/quickTaskStore';
import type { QuickTask } from '../../types/project';

const STATUS_ICON: Record<string, string> = {
  pending: '📋',
  in_progress: '🔄',
  done: '✅',
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--text-muted)',
  in_progress: 'var(--warning, #ffcc00)',
  done: '#4aba6a',
};

/** Cycles through pending → in_progress → done → pending */
function nextStatus(current: QuickTask['status']): QuickTask['status'] {
  if (current === 'pending') return 'in_progress';
  if (current === 'in_progress') return 'done';
  return 'pending';
}

export default function QuickTaskSection() {
  const tasks = useQuickTaskStore((s) => s.tasks);
  const loaded = useQuickTaskStore((s) => s.loaded);
  const fetchTasks = useQuickTaskStore((s) => s.fetchTasks);
  const createTask = useQuickTaskStore((s) => s.createTask);
  const updateTask = useQuickTaskStore((s) => s.updateTask);
  const deleteTask = useQuickTaskStore((s) => s.deleteTask);

  const [expanded, setExpanded] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newAssignedTo, setNewAssignedTo] = useState('');

  useEffect(() => {
    fetchTasks().catch(console.error);
  }, [fetchTasks]);

  const handleCreate = useCallback(async () => {
    if (!newTitle.trim()) return;
    try {
      await createTask(newTitle.trim(), newAssignedTo.trim());
      setNewTitle('');
      setNewAssignedTo('');
      setShowForm(false);
    } catch (err) {
      console.error('[quick-tasks] create failed:', err);
    }
  }, [newTitle, newAssignedTo, createTask]);

  const handleStatusToggle = useCallback(async (task: QuickTask) => {
    try {
      await updateTask(task.id, { status: nextStatus(task.status) });
    } catch (err) {
      console.error('[quick-tasks] status update failed:', err);
    }
  }, [updateTask]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteTask(id);
    } catch (err) {
      console.error('[quick-tasks] delete failed:', err);
    }
  }, [deleteTask]);

  // Sort: in_progress first, then pending, then done
  const sorted = [...tasks].sort((a, b) => {
    const order: Record<string, number> = { in_progress: 0, pending: 1, done: 2 };
    return (order[a.status] ?? 1) - (order[b.status] ?? 1);
  });

  const activeTasks = tasks.filter((t) => t.status !== 'done');
  const doneTasks = tasks.filter((t) => t.status === 'done');

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header} onClick={() => setExpanded((e) => !e)}>
        <div style={styles.headerLeft}>
          <span style={styles.toggle}>{expanded ? '▾' : '▸'}</span>
          <span style={styles.sectionTitle}>⚡ Quick Tasks</span>
          {tasks.length > 0 && (
            <span style={styles.count}>
              {activeTasks.length} active{doneTasks.length > 0 ? ` · ${doneTasks.length} done` : ''}
            </span>
          )}
        </div>
        <button
          style={styles.addBtn}
          onClick={(e) => {
            e.stopPropagation();
            setShowForm((f) => !f);
            if (!expanded) setExpanded(true);
          }}
          title="Add quick task"
        >
          +
        </button>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={styles.body}>
          {/* Add task form */}
          {showForm && (
            <div style={styles.form}>
              <input
                style={styles.input}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Task title…"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') setShowForm(false);
                }}
              />
              <input
                style={{ ...styles.input, flex: '0 0 100px' }}
                value={newAssignedTo}
                onChange={(e) => setNewAssignedTo(e.target.value)}
                placeholder="Assigned to…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') setShowForm(false);
                }}
              />
              <button
                style={styles.createBtn}
                onClick={handleCreate}
                disabled={!newTitle.trim()}
              >
                Add
              </button>
            </div>
          )}

          {/* Loading */}
          {!loaded && (
            <p style={styles.muted}>Loading…</p>
          )}

          {/* Empty state */}
          {loaded && tasks.length === 0 && !showForm && (
            <p style={styles.muted}>
              No quick tasks yet. Click + to add one.
            </p>
          )}

          {/* Task list */}
          {sorted.map((task) => (
            <QuickTaskRow
              key={task.id}
              task={task}
              onToggleStatus={() => handleStatusToggle(task)}
              onDelete={() => handleDelete(task.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Individual task row ──

function QuickTaskRow({
  task,
  onToggleStatus,
  onDelete,
}: {
  task: QuickTask;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  const isDone = task.status === 'done';

  return (
    <div style={{
      ...styles.taskRow,
      opacity: isDone ? 0.5 : 1,
    }}>
      {/* Click status icon to cycle */}
      <button
        style={styles.statusBtn}
        onClick={onToggleStatus}
        title={`Status: ${task.status} — click to change`}
      >
        {STATUS_ICON[task.status]}
      </button>

      <span style={{
        ...styles.taskTitle,
        textDecoration: isDone ? 'line-through' : 'none',
      }}>
        {task.title}
      </span>

      {task.assignedTo && (
        <span style={styles.assignee}>{task.assignedTo}</span>
      )}

      <span style={{
        ...styles.statusLabel,
        color: STATUS_COLOR[task.status],
      }}>
        {task.status.replace('_', ' ')}
      </span>

      <button
        style={styles.deleteBtn}
        onClick={onDelete}
        title="Delete task"
      >
        ×
      </button>
    </div>
  );
}

// ── Styles ──

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: '#1e1e20',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    cursor: 'pointer',
    userSelect: 'none',
  } as React.CSSProperties,
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    flex: 1,
    minWidth: 0,
  },
  toggle: {
    fontSize: 10,
    color: 'var(--text-muted)',
    width: 12,
    flexShrink: 0,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  count: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontWeight: 500,
  },
  addBtn: {
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    background: 'rgba(26, 122, 60, 0.12)',
    border: '1px solid rgba(26, 122, 60, 0.2)',
    color: '#4aba6a',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
  },
  body: {
    padding: '0 14px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    borderTop: '1px solid rgba(255, 255, 255, 0.05)',
    paddingTop: 10,
  } as React.CSSProperties,
  form: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    marginBottom: 4,
  },
  input: {
    flex: 1,
    fontSize: 12,
    color: 'var(--text-primary)',
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: 6,
    padding: '6px 10px',
    outline: 'none',
  } as React.CSSProperties,
  createBtn: {
    padding: '5px 12px',
    borderRadius: 6,
    background: 'var(--accent)',
    border: 'none',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
  },
  muted: {
    fontSize: 12,
    color: 'var(--text-muted)',
    margin: 0,
    fontStyle: 'italic',
    padding: '4px 0',
  },
  taskRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 4px',
    borderRadius: 6,
    transition: 'opacity 0.2s',
  },
  statusBtn: {
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    flexShrink: 0,
  },
  taskTitle: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    flex: 1,
    lineHeight: 1.4,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  assignee: {
    fontSize: 10,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
    flexShrink: 0,
  },
  statusLabel: {
    fontSize: 10,
    fontWeight: 600,
    flexShrink: 0,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
  } as React.CSSProperties,
  deleteBtn: {
    width: 20,
    height: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    background: 'rgba(192, 57, 43, 0.08)',
    border: 'none',
    color: 'var(--danger, #c0392b)',
    fontSize: 14,
    cursor: 'pointer',
    flexShrink: 0,
    opacity: 0.6,
    transition: 'opacity 0.15s',
  },
};
