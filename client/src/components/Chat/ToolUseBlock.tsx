import { useState } from 'react';
import type { ToolUse } from '../../types/message';

interface ToolUseBlockProps {
  tool: ToolUse;
}

/** Output lines shown before the "show all" control appears. */
const OUTPUT_PREVIEW_LINES = 20;

function formatInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    // Circular or otherwise unserializable input should not blank the card.
    return String(input);
  }
}

/** A one-line hint of what the call was about, shown on the collapsed header. */
function summarizeInput(input: unknown): string {
  if (input == null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'description']) {
    const value = obj[key];
    if (typeof value === 'string' && value) {
      return value.length > 60 ? `${value.slice(0, 57)}...` : value;
    }
  }
  return '';
}

export default function ToolUseBlock({ tool }: ToolUseBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);

  const isSubagent = tool.parentToolUseId != null;
  const isError = tool.isError === true;

  const inputText = formatInput(tool.input);
  const summary = summarizeInput(tool.input);

  const outputLines = tool.output != null ? tool.output.split('\n') : [];
  const truncated = outputLines.length > OUTPUT_PREVIEW_LINES;
  const visibleOutput =
    truncated && !showFullOutput
      ? outputLines.slice(0, OUTPUT_PREVIEW_LINES).join('\n')
      : tool.output ?? '';
  const hiddenLineCount = outputLines.length - OUTPUT_PREVIEW_LINES;

  return (
    <div
      style={{
        ...styles.container,
        border: isError
          ? '1px solid rgba(192, 57, 43, 0.45)'
          : '1px solid rgba(255, 255, 255, 0.06)',
      }}
    >
      <button onClick={() => setExpanded(!expanded)} style={styles.header}>
        <span style={styles.chevron}>{expanded ? '▼' : '▶'}</span>
        <span
          style={{
            ...styles.name,
            color: isError ? 'var(--danger)' : 'var(--text-secondary)',
          }}
        >
          {tool.name}
        </span>
        {isSubagent && <span style={styles.badge}>subagent</span>}
        {isError && <span style={styles.errorBadge}>error</span>}
        {summary && !expanded && <span style={styles.summary}>{summary}</span>}
      </button>

      {expanded && (
        <div style={styles.body}>
          {inputText && (
            <div style={styles.section}>
              <div style={styles.label}>Input</div>
              <pre style={styles.code}>{inputText}</pre>
            </div>
          )}

          {tool.output != null && (
            <div style={styles.section}>
              <div style={styles.label}>{isError ? 'Error' : 'Output'}</div>
              <pre
                style={{
                  ...styles.code,
                  color: isError ? 'var(--danger)' : 'var(--text-secondary)',
                }}
              >
                {visibleOutput}
              </pre>
              {truncated && (
                <button
                  onClick={() => setShowFullOutput(!showFullOutput)}
                  style={styles.expandButton}
                >
                  {showFullOutput
                    ? 'Show less'
                    : `Show ${hiddenLineCount} more line${hiddenLineCount === 1 ? '' : 's'}`}
                </button>
              )}
            </div>
          )}

          {tool.output == null && (
            <div style={{ ...styles.section, ...styles.pending }}>Running...</div>
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
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '6px 10px',
    textAlign: 'left',
    color: 'var(--text-secondary)',
    fontSize: 13,
  },
  chevron: {
    fontSize: 10,
    width: 14,
    flexShrink: 0,
  },
  name: {
    fontWeight: 600,
    fontFamily: 'var(--font-mono)',
  },
  badge: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    padding: '1px 6px',
    borderRadius: 999,
    color: 'var(--text-muted)',
    background: 'rgba(255, 255, 255, 0.07)',
    flexShrink: 0,
  },
  errorBadge: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    padding: '1px 6px',
    borderRadius: 999,
    color: 'var(--danger)',
    background: 'rgba(192, 57, 43, 0.16)',
    flexShrink: 0,
  },
  summary: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  body: {
    padding: '0 10px 8px',
  },
  section: {
    marginTop: 4,
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 2,
  },
  code: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    lineHeight: 1.4,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    margin: 0,
    maxHeight: 300,
    overflowY: 'auto',
  },
  expandButton: {
    marginTop: 4,
    padding: '2px 6px',
    fontSize: 11,
    color: 'var(--accent)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
  pending: {
    fontSize: 12,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
};
