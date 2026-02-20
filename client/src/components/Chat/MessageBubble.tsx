import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage } from '../../types/message';
import ToolUseBlock from './ToolUseBlock';

interface MessageBubbleProps {
  message: ChatMessage;
  botName?: string;
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

export default function MessageBubble({ message, botName }: MessageBubbleProps) {
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
        ) : (
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
        )}

        {/* Tool uses */}
        {message.toolUses && message.toolUses.length > 0 && (
          <div style={styles.tools}>
            {message.toolUses.map((tool, i) => (
              <ToolUseBlock key={i} tool={tool} />
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
    justifyContent: 'space-between',
    marginBottom: 6,
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
};
