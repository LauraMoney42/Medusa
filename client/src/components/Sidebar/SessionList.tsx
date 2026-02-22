import { useState, useRef, useEffect, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useTaskStore, hasCompletedTask } from '../../stores/taskStore';
import { useDraftStore } from '../../stores/draftStore';
import SessionEditor from './SessionEditor';

/** 4-state status icon: busy (spinning cog) > complete (checkmark) > pending (pulsing) > idle (gray dot) */
function StatusIcon({ status, hasPendingTask, hasCompleted }: {
  status: 'idle' | 'busy';
  hasPendingTask: boolean;
  hasCompleted: boolean;
}) {
  // Busy MUST take priority — when a bot is actively streaming, always show the cog
  if (status === 'busy') {
    return (
      <span style={statusStyles.spinningCog}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </span>
    );
  }
  if (hasCompleted) {
    return <span style={statusStyles.checkmark}>✓</span>;
  }
  if (hasPendingTask) {
    return <span style={statusStyles.pulsingDot} />;
  }
  return <span style={statusStyles.idleDot} />;
}

const statusStyles: Record<string, React.CSSProperties> = {
  idleDot: {
    width: 8, height: 8, borderRadius: '50%',
    background: 'var(--text-muted)',
    flexShrink: 0,
  },
  pulsingDot: {
    width: 8, height: 8, borderRadius: '50%',
    background: 'var(--success)',
    animation: 'pendingPulse 2s ease-in-out infinite',
    flexShrink: 0,
  },
  spinningCog: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 14, height: 14,
    color: 'var(--accent)',
    animation: 'cogSpin 2s linear infinite',
    flexShrink: 0,
  } as React.CSSProperties,
  checkmark: {
    fontSize: 12, fontWeight: 700, lineHeight: '8px',
    color: 'var(--success)',
    flexShrink: 0,
  },
  draftDot: {
    width: 5, height: 5, borderRadius: '50%',
    background: 'var(--text-muted)',
    flexShrink: 0,
    opacity: 0.6,
  },
};

export default function SessionList() {
  const sessions = useSessionStore((s) => s.sessions);
  const statuses = useSessionStore((s) => s.statuses);
  const pendingTasks = useSessionStore((s) => s.pendingTasks);
  const completedTasks = useTaskStore((s) => s.completedTasks);
  // DM5: Draft indicator — subscribe to drafts so dot updates reactively
  const drafts = useDraftStore((s) => s.drafts);
  const renameSession = useSessionStore((s) => s.renameSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const reorderSessions = useSessionStore((s) => s.reorderSessions);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);

  // Editor state
  const [editingId, setEditingId] = useState<string | null>(null);

  // Rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Drag state
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const handleContextMenu = (
    e: React.MouseEvent,
    sessionId: string,
  ) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  };

  const handleRenameStart = (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    setRenamingId(sessionId);
    setRenameValue(session.name);
    setContextMenu(null);
  };

  const handleRenameSubmit = async (id: string) => {
    const trimmed = renameValue.trim();
    if (trimmed) {
      await renameSession(id, trimmed);
    }
    setRenamingId(null);
  };

  const handleDelete = async (id: string) => {
    setContextMenu(null);
    await deleteSession(id);
  };

  // Drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, sessionId: string) => {
    setDragId(sessionId);
    e.dataTransfer.effectAllowed = 'move';
    // Make the drag image semi-transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.4';
    }
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1';
    }
    setDragId(null);
    setDragOverId(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, sessionId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (sessionId !== dragId) {
      setDragOverId(sessionId);
    }
  }, [dragId]);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) return;

    const fromIndex = sessions.findIndex((s) => s.id === dragId);
    const toIndex = sessions.findIndex((s) => s.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;

    const newOrder = [...sessions];
    const [moved] = newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, moved);

    reorderSessions(newOrder.map((s) => s.id));
    setDragId(null);
    setDragOverId(null);
  }, [dragId, sessions, reorderSessions]);

  return (
    <div style={styles.container}>
      {sessions.length === 0 && (
        <p style={styles.empty}>No bots yet</p>
      )}

      {sessions.map((session) => {
        const status = statuses[session.id] ?? 'idle';
        const isDragOver = dragOverId === session.id && dragId !== session.id;

        return (
          <div
            key={session.id}
            draggable={!renamingId}
            onDragStart={(e) => handleDragStart(e, session.id)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, session.id)}
            onDrop={(e) => handleDrop(e, session.id)}
            onContextMenu={(e) => handleContextMenu(e, session.id)}
            style={{
              ...styles.item,
              borderTop: isDragOver ? '2px solid var(--accent)' : '2px solid transparent',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                'rgba(255,255,255,0.03)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                'transparent';
            }}
          >
            <StatusIcon
              status={status}
              hasPendingTask={!!pendingTasks[session.id]}
              hasCompleted={hasCompletedTask(completedTasks, session.id)}
            />

            {renamingId === session.id ? (
              <input
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => handleRenameSubmit(session.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameSubmit(session.id);
                  if (e.key === 'Escape') setRenamingId(null);
                }}
                style={styles.renameInput}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span style={styles.name}>{session.name}</span>
                {/* DM5: Draft indicator dot — subtle, only when unsent draft exists */}
                {drafts[session.id] && (
                  <span style={statusStyles.draftDot} title="Unsent draft" />
                )}
                <button
                  className="session-edit-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(session.id);
                  }}
                  title="Edit session settings"
                  style={styles.editBtn}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    <path d="m15 5 4 4" />
                  </svg>
                </button>
              </>
            )}
          </div>
        );
      })}

      {/* Session editor modal */}
      {editingId && (() => {
        const editSession = sessions.find((s) => s.id === editingId);
        if (!editSession) return null;
        return (
          <SessionEditor
            session={editSession}
            onClose={() => setEditingId(null)}
          />
        );
      })()}

      {/* Context menu */}
      {contextMenu && (
        <div
          style={{
            ...styles.contextMenu,
            top: contextMenu.y,
            left: contextMenu.x,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            style={styles.contextItem}
            onClick={() => handleRenameStart(contextMenu.sessionId)}
          >
            Rename
          </button>
          <button
            style={{ ...styles.contextItem, color: 'var(--danger)' }}
            onClick={() => handleDelete(contextMenu.sessionId)}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 0',
  },
  empty: {
    color: 'var(--text-muted)',
    fontSize: 13,
    textAlign: 'center',
    padding: '24px 16px',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 14px',
    cursor: 'default',
    borderRadius: 'var(--radius-sm)',
    margin: '0 10px',
    transition: 'background 0.1s',
  },
  name: {
    fontSize: 13.5,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  renameInput: {
    flex: 1,
    padding: '2px 6px',
    background: 'rgba(0, 0, 0, 0.25)',
    border: '1px solid var(--accent)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 14,
  },
  contextMenu: {
    position: 'fixed',
    background: '#2c2c2e',
    border: '1px solid rgba(255, 255, 255, 0.10)',
    borderRadius: 'var(--radius)',
    padding: 6,
    zIndex: 200,
    boxShadow: '0 12px 48px rgba(0, 0, 0, 0.5)',
    minWidth: 140,
  },
  contextItem: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '8px 14px',
    fontSize: 14,
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
  },
  editBtn: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    opacity: 0,
    transition: 'opacity 0.15s, color 0.15s',
    flexShrink: 0,
  },
};
