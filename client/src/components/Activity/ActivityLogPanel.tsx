import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useActivityStore,
  type ActivityEntry,
  type ActivityKind,
} from '../../stores/activityStore';

interface ActivityLogPanelProps {
  /** The chat whose raw stream this panel shows. */
  sessionId: string;
}

/** Badge colour per kind. Subagent lines share the accent so they read as one group. */
const KIND_COLOR: Record<ActivityKind, string> = {
  init: 'var(--text-muted)',
  text: 'var(--text-secondary)',
  thinking: 'var(--warning)',
  tool: 'var(--accent)',
  tool_input: 'var(--text-muted)',
  tool_result: 'var(--text-secondary)',
  assistant: 'var(--text-secondary)',
  result: 'var(--success)',
  error: 'var(--danger)',
  subagent_start: 'var(--accent)',
  subagent_text: 'var(--text-secondary)',
  subagent_tool: 'var(--accent)',
  subagent_tool_result: 'var(--text-secondary)',
  subagent_end: 'var(--success)',
};

/** Short badge labels; the full kind is on the title attribute. */
const KIND_LABEL: Record<ActivityKind, string> = {
  init: 'init',
  text: 'text',
  thinking: 'think',
  tool: 'tool',
  tool_input: 'input',
  tool_result: 'result',
  assistant: 'msg',
  result: 'turn',
  error: 'error',
  subagent_start: 'sub+',
  subagent_text: 'sub',
  subagent_tool: 'sub tool',
  subagent_tool_result: 'sub res',
  subagent_end: 'sub✓',
};

function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatTokens(entry: ActivityEntry): string {
  const t = entry.tokens;
  if (!t) return '';
  const parts: string[] = [];
  if (t.input != null) parts.push(`in ${t.input}`);
  if (t.output != null) parts.push(`out ${t.output}`);
  if (t.costUsd != null && t.costUsd > 0) parts.push(`$${t.costUsd.toFixed(4)}`);
  return parts.join(' · ');
}

/**
 * The far-right Activity Log (UI addendum): the full raw stream for the
 * current chat, one timestamped line per event, expandable to the untruncated
 * detail the server sent. Thinking blocks render in full rather than clipped
 * to their summary, since they are the whole reason to open this panel.
 */
export default function ActivityLogPanel({ sessionId }: ActivityLogPanelProps) {
  const entries = useActivityStore((s) => s.bySession[sessionId]);
  const clear = useActivityStore((s) => s.clear);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll pauses the moment the reader scrolls up, and resumes when
  // they come back to the bottom: a log that yanks itself down mid-read is
  // unusable while a turn is streaming.
  const [pinned, setPinned] = useState(true);

  const all = useMemo(() => entries ?? [], [entries]);
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (e) =>
        e.kind.includes(needle) ||
        e.summary.toLowerCase().includes(needle) ||
        (e.detail ? e.detail.toLowerCase().includes(needle) : false) ||
        (e.subagentId ? e.subagentId.toLowerCase().includes(needle) : false),
    );
  }, [all, filter]);

  useEffect(() => {
    if (!pinned) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, pinned]);

  // A different chat starts a fresh read: snap back to the bottom.
  useEffect(() => {
    setPinned(true);
    setExpanded({});
  }, [sessionId]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setPinned(atBottom);
  };

  return (
    <div style={styles.panel}>
      <div style={styles.toolbar}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter"
          style={styles.filter}
        />
        <button
          onClick={() => clear(sessionId)}
          style={styles.clearBtn}
          title="Clear this chat's log"
        >
          Clear
        </button>
      </div>

      <div ref={listRef} onScroll={handleScroll} style={styles.list}>
        {visible.length === 0 ? (
          <div style={styles.empty}>
            {all.length === 0 ? 'No activity yet.' : 'No lines match the filter.'}
          </div>
        ) : (
          visible.map((entry) => {
            const isOpen = expanded[entry.id] === true;
            const tokens = formatTokens(entry);
            // Thinking is shown in full on sight; everything else opens on click.
            const showDetail = entry.detail != null && (isOpen || entry.kind === 'thinking');
            return (
              <div key={entry.id} style={styles.line}>
                <button
                  onClick={() =>
                    setExpanded((prev) => ({ ...prev, [entry.id]: !isOpen }))
                  }
                  style={styles.lineHeader}
                  title={entry.kind}
                >
                  <span style={styles.time}>{formatTime(entry.ts)}</span>
                  <span
                    style={{
                      ...styles.badge,
                      color: KIND_COLOR[entry.kind] ?? 'var(--text-muted)',
                      borderColor: KIND_COLOR[entry.kind] ?? 'var(--text-muted)',
                    }}
                  >
                    {KIND_LABEL[entry.kind] ?? entry.kind}
                  </span>
                  <span style={styles.summary}>{entry.summary}</span>
                  {tokens && <span style={styles.tokens}>{tokens}</span>}
                  {entry.detail != null && entry.kind !== 'thinking' && (
                    <span style={styles.chevron}>{isOpen ? '▼' : '▶'}</span>
                  )}
                </button>
                {showDetail && (
                  <pre style={styles.detail}>
                    {entry.detail}
                    {entry.detailTruncated ? '\n… truncated at 8k' : ''}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>

      <div style={styles.footer}>
        <span>
          {visible.length === all.length
            ? `${all.length} log${all.length === 1 ? '' : 's'}`
            : `${visible.length} of ${all.length} logs`}
        </span>
        {!pinned && (
          <button
            onClick={() => setPinned(true)}
            style={styles.resumeBtn}
            title="Resume auto-scroll"
          >
            Auto-scroll paused
          </button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minWidth: 0,
    background: 'var(--bg-tertiary)',
    borderLeft: '1px solid var(--border)',
    color: 'var(--text-secondary)',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 10px',
    borderBottom: '1px solid var(--border)',
  },
  filter: {
    flex: 1,
    minWidth: 0,
    padding: '4px 8px',
    fontSize: 12,
    color: 'var(--text-primary)',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    outline: 'none',
  },
  clearBtn: {
    padding: '4px 8px',
    fontSize: 11,
    color: 'var(--text-secondary)',
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '4px 0',
  },
  empty: {
    padding: 16,
    fontSize: 12,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
  line: {
    borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
  },
  lineHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    width: '100%',
    padding: '3px 10px',
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
  },
  time: {
    color: 'var(--text-muted)',
    flexShrink: 0,
  },
  badge: {
    fontSize: 9,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    padding: '0 4px',
    border: '1px solid',
    borderRadius: 4,
    flexShrink: 0,
    opacity: 0.85,
  },
  summary: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tokens: {
    color: 'var(--text-muted)',
    flexShrink: 0,
  },
  chevron: {
    color: 'var(--text-muted)',
    fontSize: 8,
    flexShrink: 0,
  },
  detail: {
    margin: 0,
    padding: '4px 10px 8px 60px',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    lineHeight: 1.45,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 360,
    overflowY: 'auto',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '6px 10px',
    borderTop: '1px solid var(--border)',
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  resumeBtn: {
    padding: '2px 6px',
    fontSize: 10,
    color: 'var(--accent)',
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
  },
};
