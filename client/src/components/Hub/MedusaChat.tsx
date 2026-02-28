import { useEffect, useRef, useState, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore } from '../../stores/chatStore';
import { getSocket } from '../../socket';
import ScreenshotButton from '../Input/ScreenshotButton';
import { uploadImage } from '../../api';

interface MedusaChatProps {
  onMenuToggle?: () => void;
}

export default function MedusaChat({ onMenuToggle }: MedusaChatProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const messages = useChatStore((s) => s.messages);
  const loadMessages = useChatStore((s) => s.loadMessages);

  const [text, setText] = useState('');
  const [images, setImages] = useState<{ file: File; preview: string }[]>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);

  // Find the Medusa session
  const medusaSession = sessions.find((s) => s.name.toLowerCase() === 'medusa');

  // On mount, load messages and set as active session
  useEffect(() => {
    if (!medusaSession) return;

    setActiveSession(medusaSession.id);
    loadMessages(medusaSession.id).catch(console.error);
  }, [medusaSession, setActiveSession, loadMessages]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
    }
  }, [text]);

  // Scroll to bottom when messages change or on mount
  const chatMessagesForScroll = medusaSession ? messages[medusaSession.id] : undefined;
  useEffect(() => {
    const el = messageListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chatMessagesForScroll]);

  const handleSendMessage = useCallback(async () => {
    if (!medusaSession) return;
    if (!text.trim() && (!images || images.length === 0)) return;

    // Upload images
    const uploadedPaths: string[] = [];
    for (const img of images ?? []) {
      try {
        const { filePath } = await uploadImage(img.file);
        uploadedPaths.push(filePath);
      } catch (err) {
        console.error('Image upload failed:', err);
      }
    }

    const socket = getSocket();
    socket.emit('message:send', {
      sessionId: medusaSession.id,
      text: text.trim(),
      ...(uploadedPaths.length > 0 ? { images: uploadedPaths } : {}),
    });

    setText('');
    setImages([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, images, medusaSession]);

  const handleScreenshot = useCallback((file: File, preview: string) => {
    setImages((prev) => [...(prev ?? []), { file, preview }]);
  }, []);

  const handleRemoveImage = useCallback((idx: number) => {
    setImages((prev) => {
      if (!prev) return prev;
      const next = prev.filter((_, i) => i !== idx);
      return next.length === 0 ? undefined : next;
    });
  }, []);

  if (!medusaSession) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>Medusa bot not found</div>
      </div>
    );
  }

  const chatMessages = messages[medusaSession.id] ?? [];

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button
          onClick={onMenuToggle}
          style={styles.menuBtn}
          title="Menu"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <h2 style={styles.title}>Medusa</h2>
        <div style={{ width: 28 }} />
      </div>

      {/* Messages */}
      <div ref={messageListRef} style={styles.messageList}>
        {chatMessages.length === 0 ? (
          <div style={styles.emptyState}>
            Start a conversation with Medusa
          </div>
        ) : (
          chatMessages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))
        )}
      </div>

      {/* Input area */}
      <div style={styles.inputContainer}>
        {/* Image previews */}
        {images && images.length > 0 && (
          <div style={styles.imageRow}>
            {images.map((img, idx) => (
              <div key={idx} style={styles.imagePreview}>
                <img src={img.preview} alt="Attached" style={styles.imageThumb} />
                <button
                  onClick={() => handleRemoveImage(idx)}
                  style={styles.imageRemove}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea + buttons */}
        <div style={styles.inputRow}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            placeholder="Message Medusa..."
            style={styles.textarea}
          />

          <div style={styles.buttonRow}>
            <ScreenshotButton
              onCapture={handleScreenshot}
              disabled={false}
            />
            <button
              onClick={handleSendMessage}
              disabled={!text.trim() && (!images || images.length === 0)}
              style={styles.sendBtn}
              title="Send (Enter)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Render a single message bubble */
function MessageBubble({ message }: { message: any }) {
  const isUser = message.role === 'user';
  const displayName = isUser ? 'You' : 'Medusa';
  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div style={{ justifyContent: isUser ? 'flex-end' : 'flex-start', display: 'flex' }}>
      <div
        style={{
          ...styles.bubble,
          background: isUser ? 'rgba(74, 186, 106, 0.12)' : '#232325',
          border: isUser ? '1px solid rgba(74, 186, 106, 0.2)' : '1px solid rgba(255,255,255,0.08)',
          borderBottomLeftRadius: isUser ? 10 : 4,
          borderBottomRightRadius: isUser ? 4 : 10,
        }}
      >
        <div style={styles.bubbleHeader}>
          <span style={{ color: '#4aba6a' }}>{displayName}</span>
          <span style={styles.time}>{timestamp}</span>
        </div>
        <div style={styles.bubbleText}>{message.text}</div>
        {message.images && message.images.length > 0 && (
          <div style={styles.bubbleImages}>
            {message.images.map((src: string, i: number) => (
              <img key={i} src={src} alt="Attached" style={{ maxWidth: 200, borderRadius: 6 }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    background: '#1a1a1c',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 130px 14px 16px', // paddingRight 130px clears fixed CaffeineToggle (top:12, right:14)
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
  } as React.CSSProperties,
  menuBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: '4px',
    display: 'flex',
    alignItems: 'center',
  } as React.CSSProperties,
  title: {
    fontSize: 16,
    fontWeight: 700,
    color: '#4aba6a',
    margin: 0,
  },
  messageList: {
    flex: 1,
    overflow: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  } as React.CSSProperties,
  emptyState: {
    textAlign: 'center' as const,
    color: 'var(--text-muted)',
    fontSize: 14,
    margin: 'auto',
  },
  bubble: {
    maxWidth: '70%',
    padding: '10px 14px',
    borderRadius: 18,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  } as React.CSSProperties,
  bubbleHeader: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  } as React.CSSProperties,
  time: {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginLeft: 'auto',
  },
  bubbleText: {
    fontSize: 13,
    color: 'var(--text-primary)',
    lineHeight: 1.4,
    wordBreak: 'break-word' as const,
  },
  bubbleImages: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap' as const,
    marginTop: 4,
  } as React.CSSProperties,
  inputContainer: {
    padding: '12px 16px',
    borderTop: '1px solid rgba(255, 255, 255, 0.08)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  } as React.CSSProperties,
  imageRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,
  imagePreview: {
    position: 'relative',
    width: 60,
    height: 60,
    borderRadius: 6,
    overflow: 'hidden',
    border: '1px solid rgba(255, 255, 255, 0.1)',
  } as React.CSSProperties,
  imageThumb: {
    width: '100%',
    height: '100%',
    objectFit: 'cover' as const,
  },
  imageRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    background: '#ef4444',
    color: '#fff',
    border: 'none',
    borderRadius: '50%',
    cursor: 'pointer',
    fontSize: 12,
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as React.CSSProperties,
  inputRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-end',
  } as React.CSSProperties,
  textarea: {
    flex: 1,
    padding: '10px 12px',
    fontSize: 13,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--text-primary)',
    resize: 'none',
    maxHeight: 150,
    fontFamily: 'inherit',
    minHeight: 40,
  } as React.CSSProperties,
  buttonRow: {
    display: 'flex',
    gap: 4,
  } as React.CSSProperties,
  sendBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(26, 122, 60, 0.18)',
    border: '1px solid rgba(26, 122, 60, 0.25)',
    color: '#4aba6a',
    cursor: 'pointer',
    transition: 'all 0.15s',
  } as React.CSSProperties,
};
