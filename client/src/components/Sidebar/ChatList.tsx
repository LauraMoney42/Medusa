import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore } from '../../stores/chatStore';
import { useDraftStore } from '../../stores/draftStore';
import SessionEditor from './SessionEditor';
import type { SessionMeta } from '../../types/session';

interface ChatListProps {
  /** Search text from the rail's field. */
  query: string;
}

/**
 * The "Recent" list: one row per chat, title plus message count, the active
 * chat outlined in the accent.
 *
 * The only status indicator left is the streaming dot. Every bot-era symbol
 * (spinning cog, pause, status-requested, checkmark, pending pulse) is gone
 * along with the bots themselves.
 */
export default function ChatList({ query }: ChatListProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const setActiveView = useSessionStore((s) => s.setActiveView);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const renameSession = useSessionStore((s) => s.renameSession);
  const statuses = useSessionStore((s) => s.statuses);
  const messages = useChatStore((s) => s.messages);
  const drafts = useDraftStore((s) => s.drafts);

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [editing, setEditing] = useState<SessionMeta | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) renameRef.current?.focus();
  }, [renamingId]);

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.workingDir ?? '').toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const commitRename = async (id: string) => {
    const next = renameText.trim();
    setRenamingId(null);
    if (!next) return;
    try {
      await renameSession(id, next);
    } catch (err) {
      console.error('[chat-list] rename failed:', err);
    }
  };

  const handleDelete = async (session: SessionMeta) => {
    setMenuFor(null);
    if (!window.confirm(`Delete "${session.name}"? Its history stays on disk.`)) return;
    try {
      await deleteSession(session.id);
    } catch (err) {
      console.error('[chat-list] delete failed:', err);
    }
  };

  if (sessions.length === 0) {
    return <p style={styles.empty}>No chats yet</p>;
  }

  if (filtered.length === 0) {
    return <p style={styles.empty}>No chats match “{query.trim()}”</p>;
  }

  return (
    <>
      <div style={styles.list}>
        {filtered.map((session) => {
          const isActive = session.id === activeSessionId;
          const count = messages[session.id]?.length;
          const streaming = statuses[session.id] === 'busy';
          return (
            <div
              key={session.id}
              onClick={() => {
                setActiveSession(session.id);
                setActiveView('chat');
              }}
              onDoubleClick={() => {
                setRenamingId(session.id);
                setRenameText(session.name);
              }}
              style={{
                ...styles.row,
                background: isActive ? 'rgba(26, 122, 60, 0.12)' : 'transparent',
                border: isActive
                  ? '1px solid var(--accent)'
                  : '1px solid transparent',
              }}
              title={session.workingDir}
            >
              {renamingId === session.id ? (
                <input
                  ref={renameRef}
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={() => void commitRename(session.id)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(session.id);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  style={styles.renameInput}
                />
              ) : (
                <span
                  style={{
                    ...styles.name,
                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: isActive ? 600 : 500,
                  }}
                >
                  {session.name}
                </span>
              )}

              {drafts[session.id] && <span style={styles.draftDot} title="Unsent draft" />}
              {streaming && <span style={styles.streamDot} title="Working" />}
              {count != null && <span style={styles.count}>{count}</span>}

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor(menuFor === session.id ? null : session.id);
                }}
                style={styles.menuBtn}
                title="Chat actions"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>

              {menuFor === session.id && (
                <div style={styles.menu} onClick={(e) => e.stopPropagation()}>
                  <button
                    style={styles.menuItem}
                    onClick={() => {
                      setMenuFor(null);
                      setRenamingId(session.id);
                      setRenameText(session.name);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    style={styles.menuItem}
                    onClick={() => {
                      setMenuFor(null);
                      setEditing(session);
                    }}
                  >
                    Chat settings
                  </button>
                  <button
                    style={{ ...styles.menuItem, color: 'var(--danger)' }}
                    onClick={() => void handleDelete(session)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {editing && <SessionEditor session={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '0 8px',
  },
  row: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 8px',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    minWidth: 0,
  },
  name: {
    flex: 1,
    fontSize: 13,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  },
  renameInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    padding: '2px 4px',
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid var(--accent)',
    borderRadius: 4,
    color: 'var(--text-primary)',
    fontFamily: 'inherit',
  },
  count: {
    fontSize: 11,
    color: 'var(--text-muted)',
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
  },
  draftDot: {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: 'var(--text-muted)',
    flexShrink: 0,
  },
  streamDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: '#4aba6a',
    animation: 'pendingPulse 1.4s ease-in-out infinite',
    flexShrink: 0,
  },
  menuBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 2,
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  menu: {
    position: 'absolute',
    top: '100%',
    right: 4,
    zIndex: 40,
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-sm)',
    boxShadow: 'var(--glass-shadow)',
    padding: 4,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 130,
  },
  menuItem: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: 12,
    textAlign: 'left',
    padding: '6px 8px',
    borderRadius: 4,
    cursor: 'pointer',
  },
  empty: {
    fontSize: 12,
    color: 'var(--text-muted)',
    padding: '10px 16px',
    margin: 0,
  },
};
