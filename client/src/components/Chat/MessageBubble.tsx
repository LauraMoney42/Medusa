import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage } from '../../types/message';
import ToolUseBlock from './ToolUseBlock';

interface MessageBubbleProps {
  message: ChatMessage;
  botName?: string;
  /** Optional "play aloud" callback (TTS). Renders a speaker button in the header when set. */
  onSpeak?: (text: string) => void;
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export default function MessageBubble({ message, botName, onSpeak }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div
      data-message-id={message.id}
      style={{
        ...styles.row,
        justifyContent: isUser ? 'flex-end' : 'flex-start',
      }}
    >
      <div
        style={{
          ...styles.bubble,
          background: isUser ? 'rgba(26, 122, 60, 0.12)' : '#232325',
          border: isUser
            ? '1px solid rgba(26, 122, 60, 0.22)'
            : '1px solid rgba(255, 255, 255, 0.08)',
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.15)',
          maxWidth: isUser ? '70%' : '85%',
          borderRadius: isUser
            ? '18px 18px 6px 18px'
            : '18px 18px 18px 6px',
        }}
      >
        {/* Role label */}
        <div style={styles.header}>
          <span
            style={{
              ...styles.role,
              color: isUser ? 'rgba(255,255,255,0.85)' : 'var(--accent)',
            }}
          >
            {isUser ? 'You' : (botName || 'Claude')}
          </span>
          <span style={{ flex: 1 }} />
          {!isUser && onSpeak && message.text && (
            <button
              onClick={() => onSpeak(message.text)}
              title="Play aloud"
              style={styles.speakBtn}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            </button>
          )}
          <span style={styles.time}>{formatTime(message.timestamp)}</span>
        </div>

        {/* Images (for user messages with pasted images) */}
        {message.images && message.images.length > 0 && (
          <div style={styles.images}>
            {message.images.map((src, i) => (
              <img key={i} src={src} alt="" style={styles.image} />
            ))}
          </div>
        )}

        {/* Text content */}
        {isUser ? (
          <div style={styles.userText}>{message.text}</div>
        ) : message.text || message.isStreaming ? (
          <div className="markdown-body">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                // Open all links in the default browser — never navigate away from Medusa
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {message.text}
            </Markdown>
            {message.isStreaming && (
              <span style={styles.typingDots}>
                <span style={{ ...styles.dot, animationDelay: '0s' }}>.</span>
                <span style={{ ...styles.dot, animationDelay: '0.2s' }}>.</span>
                <span style={{ ...styles.dot, animationDelay: '0.4s' }}>.</span>
              </span>
            )}
          </div>
        ) : (message.toolUses && message.toolUses.length > 0) ||
          (message.errors && message.errors.length > 0) ? null : (
          // Finished with no text, no tool cards, and no error: never leave a
          // blank bubble on screen, show a clearly muted placeholder instead.
          <div style={styles.noResponse}>No response</div>
        )}

        {/* Tool uses — one card per call, with its input and its result */}
        {message.toolUses && message.toolUses.length > 0 && (
          <div style={styles.tools}>
            {message.toolUses.map((tool, i) => (
              // Prefer the tool id so a card keeps its expand state when a
              // sibling's result lands and the array is rebuilt.
              <ToolUseBlock key={tool.id ?? i} tool={tool} />
            ))}
          </div>
        )}

        {/* Engine/handler errors — rendered as clearly styled lines, never
            silently swallowed into an empty bubble. Deduped upstream so a
            tier-escalation retry that fails the same way only shows once. */}
        {message.errors && message.errors.length > 0 && (
          <div style={styles.errors}>
            {message.errors.map((err, i) => (
              <div key={i} style={styles.errorLine}>
                {err}
              </div>
            ))}
          </div>
        )}

        {/* Cost display */}
        {!isUser &&
          !message.isStreaming &&
          message.cost != null &&
          message.cost > 0 && (
            <div style={styles.cost}>
              {formatCost(message.cost)}
              {message.durationMs != null && (
                <span> &middot; {(message.durationMs / 1000).toFixed(1)}s</span>
              )}
            </div>
          )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    padding: '3px 16px',
    marginBottom: 6,
  },
  bubble: {
    padding: '12px 16px',
    lineHeight: 1.5,
    fontSize: 15,
    wordBreak: 'break-word',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  speakBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
  },
  role: {
    fontSize: 13,
    fontWeight: 600,
  },
  time: {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginLeft: 12,
  },
  userText: {
    whiteSpace: 'pre-wrap',
    color: '#fff',
  },
  typingDots: {
    display: 'inline-flex',
    gap: 2,
    marginLeft: 4,
    verticalAlign: 'middle',
  },
  dot: {
    display: 'inline-block',
    fontSize: 18,
    lineHeight: '12px',
    color: 'var(--accent)',
    animation: 'typingBounce 1.2s ease-in-out infinite',
  },
  images: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  image: {
    maxHeight: 160,
    maxWidth: 240,
    borderRadius: 'var(--radius-sm)',
    objectFit: 'cover',
  },
  tools: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 8,
  },
  cost: {
    marginTop: 8,
    fontSize: 11,
    color: 'var(--text-muted)',
    textAlign: 'right',
  },
  noResponse: {
    color: 'var(--text-muted)',
    fontStyle: 'italic',
    fontSize: 14,
  },
  errors: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 8,
  },
  errorLine: {
    fontSize: 13,
    lineHeight: 1.4,
    color: 'var(--danger)',
    background: 'rgba(192, 57, 43, 0.12)',
    border: '1px solid rgba(192, 57, 43, 0.3)',
    borderRadius: 'var(--radius-sm)',
    padding: '8px 10px',
    whiteSpace: 'pre-wrap',
  },
};
