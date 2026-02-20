import { useState } from 'react';
import type { ToolUse } from '../../types/message';

interface ToolUseBlockProps {
  tool: ToolUse;
}

export default function ToolUseBlock({ tool }: ToolUseBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={styles.container}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={styles.header}
      >
        <span style={styles.chevron}>{expanded ? '\u25BC' : '\u25B6'}</span>
        <span style={styles.name}>{tool.name}</span>
      </button>

      {expanded && (
        <div style={styles.body}>
          {tool.input != null && (
            <div style={styles.section}>
              <div style={styles.label}>Input</div>
              <pre style={styles.code}>
                {typeof tool.input === 'string'
                  ? tool.input
                  : JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}

          {tool.output != null && (
            <div style={styles.section}>
              <div style={styles.label}>Output</div>
              <pre style={styles.code}>{tool.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: 'rgba(0, 0, 0, 0.25)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
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
};
