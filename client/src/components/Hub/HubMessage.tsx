import type React from 'react';
import type { HubMessage as HubMessageType } from '../../types/hub';

interface HubMessageProps {
  message: HubMessageType;
}

/** Render message text with @mentions bolded. */
function renderWithMentions(text: string): React.ReactNode {
  // Match @word, @multi word (up to 4 words), or @all / @You etc.
  const parts = text.split(/(@[\w][\w\s]{0,40}?(?=\s|[^a-zA-Z0-9\s]|$))/g);
  return parts.map((part, i) => {
    if (part.startsWith('@')) {
      return (
        <strong key={i} style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
          {part}
        </strong>
      );
    }
    return part;
  });
}

export default function HubMessage({ message }: HubMessageProps) {
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.name}>
          {message.from}
        </span>
        <span style={styles.time}>{time}</span>
      </div>
      <div style={styles.text}>{renderWithMentions(message.text)}</div>
      {message.images && message.images.length > 0 && (
        <div style={styles.imageRow}>
          {message.images.map((src, i) => (
            <img
              key={i}
              src={src}
              alt="Attached"
              style={styles.image}
              onClick={() => window.open(src, '_blank')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '10px 14px',
    borderRadius: 'var(--radius-md, 10px)',
    background: '#232325',
    border: '1px solid rgba(255, 255, 255, 0.08)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  name: {
    fontSize: 13,
    fontWeight: 600,
    color: '#4aba6a',
    letterSpacing: '0.02em',
  },
  time: {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginLeft: 'auto',
  },
  text: {
    fontSize: 14,
    color: 'var(--text-primary)',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  } as React.CSSProperties,
  imageRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 8,
  },
  image: {
    maxWidth: 240,
    maxHeight: 180,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    cursor: 'pointer',
    objectFit: 'cover',
  } as React.CSSProperties,
};
