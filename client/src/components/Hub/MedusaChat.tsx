import { useEffect, useRef, useState, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore } from '../../stores/chatStore';
import { useTtsStore } from '../../stores/ttsStore';
import { getSocket } from '../../socket';
import { useSocket } from '../../hooks/useSocket';
import ScreenshotButton from '../Input/ScreenshotButton';
import MicButton from '../Input/MicButton';
import { useDictationInsert } from '../../hooks/useDictationInsert';
import ChatHeaderControls from './ChatHeaderControls';
import { uploadImage, synthesizeSpeech, fetchTtsStatus } from '../../api';

interface MedusaChatProps {
  onMenuToggle?: () => void;
}

export default function MedusaChat({ onMenuToggle }: MedusaChatProps) {
  // useSocket sets up the shared socket connection + listeners (side effect).
  useSocket();
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const messages = useChatStore((s) => s.messages);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const streamingId = useChatStore((s) => s.streamingMessageId);

  const [text, setText] = useState('');
  const [images, setImages] = useState<{ file: File; preview: string }[]>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);

  // Find the Medusa session
  const medusaSession = sessions.find((s) => s.name.toLowerCase() === 'medusa');

  // Agent selector — which bot this chat targets. Defaults to Medusa.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeSession = sessions.find((s) => s.id === selectedId) ?? medusaSession;

  // Voice-out (TTS): preferences live in the shared store (synced with Settings).
  const speak = useTtsStore((s) => s.speak);
  const setSpeak = useTtsStore((s) => s.setSpeak);
  const voice = useTtsStore((s) => s.voice);
  const speed = useTtsStore((s) => s.speed);
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prevStreamingRef = useRef<string | null>(null);

  // On mount, load messages and set as active session
  useEffect(() => {
    if (!activeSession) return;

    setActiveSession(activeSession.id);
    loadMessages(activeSession.id).catch(console.error);
  }, [activeSession, setActiveSession, loadMessages]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
    }
  }, [text]);

  // Scroll to bottom when messages change or on mount
  const chatMessagesForScroll = activeSession ? messages[activeSession.id] : undefined;
  useEffect(() => {
    const el = messageListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chatMessagesForScroll]);

  // Detect whether a TTS backend is configured (hide the toggle otherwise).
  useEffect(() => {
    let cancelled = false;
    fetchTtsStatus()
      .then((s) => { if (!cancelled) setTtsAvailable(s.enabled); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Speak a reply — strip markdown/code and cap length for snappy speech.
  const playTTS = useCallback(async (raw: string) => {
    const clean = raw
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_#>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
    if (!clean) return;
    try {
      const url = await synthesizeSpeech(clean, voice, speed);
      if (audioRef.current) audioRef.current.pause();
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (err) {
      console.error('TTS playback failed:', err);
    }
  }, [voice, speed]);

  // Auto-speak the active agent's reply once it finishes streaming.
  useEffect(() => {
    const prev = prevStreamingRef.current;
    prevStreamingRef.current = streamingId;
    if (!prev || streamingId || !speak || !activeSession) return;
    const list = messages[activeSession.id] ?? [];
    const msg = list.find((m) => m.id === prev);
    if (msg && msg.role !== 'user' && msg.text?.trim()) void playTTS(msg.text);
  }, [streamingId, speak, activeSession, messages, playTTS]);

  const toggleSpeak = useCallback(() => {
    const next = !speak;
    setSpeak(next);
    if (!next && audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
  }, [speak, setSpeak]);

  const handleSendMessage = useCallback(async () => {
    if (!activeSession) return;
    if (!text.trim() && (!images || images.length === 0)) return;

    const socket = getSocket();
    if (!socket.connected) {
      console.warn('[MedusaChat] Socket disconnected — message queued for reconnect');
    }

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

    socket.emit('message:send', {
      sessionId: activeSession.id,
      text: text.trim(),
      ...(uploadedPaths.length > 0 ? { images: uploadedPaths } : {}),
    });

    setText('');
    setImages([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, images, activeSession]);

  const handleScreenshot = useCallback((file: File, preview: string) => {
    setImages((prev) => [...(prev ?? []), { file, preview }]);
  }, []);

  // Insert progressive dictation into the input (auto-resize effect handles height).
  const handleTranscript = useDictationInsert(setText);

  const handleRemoveImage = useCallback((idx: number) => {
    setImages((prev) => {
      if (!prev) return prev;
      const next = prev.filter((_, i) => i !== idx);
      return next.length === 0 ? undefined : next;
    });
  }, []);

  if (!activeSession) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>Medusa bot not found</div>
      </div>
    );
  }

  const chatMessages = messages[activeSession.id] ?? [];

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={{ ...styles.header, justifyContent: 'flex-start', gap: 12 }}>
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
        <ChatHeaderControls
          sessions={sessions}
          activeSessionId={activeSession?.id ?? null}
          onSelectAgent={setSelectedId}
        />
        {ttsAvailable && (
          <button
            onClick={toggleSpeak}
            title={speak ? 'Mute replies' : 'Speak replies'}
            style={{ ...styles.speakBtn, color: speak ? '#4aba6a' : 'var(--text-muted)' }}
          >
            {speak ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={messageListRef} style={styles.messageList}>
        {chatMessages.length === 0 ? (
          <div style={styles.emptyState}>
            <img
              src="/MedusaIcon.png"
              alt="Medusa"
              style={styles.emptyIcon}
            />
            <p style={styles.emptyTitle}>Medusa</p>
            <p style={styles.emptySubtitle}>AI-Powered Development Hub</p>
            <p style={styles.emptyDescription}>
              Your PM bot. Ask Medusa to create tasks, check project status,
              plan sprints, or just think through a problem together.
            </p>
          </div>
        ) : (
          chatMessages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              botName={activeSession.name}
              onSpeak={ttsAvailable ? playTTS : undefined}
            />
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
            <MicButton onTranscript={handleTranscript} disabled={false} />
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
function MessageBubble({ message, botName, onSpeak }: { message: any; botName: string; onSpeak?: (text: string) => void }) {
  const isUser = message.role === 'user';
  const displayName = isUser ? 'You' : botName;
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
          {!isUser && onSpeak && message.text && (
            <button
              onClick={() => onSpeak(message.text)}
              title="Play aloud"
              style={styles.bubbleSpeakBtn}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            </button>
          )}
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
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    margin: 'auto',
    padding: '40px 32px',
    maxWidth: 340,
    textAlign: 'center' as const,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: '50%',
    border: '1.5px solid rgba(74, 186, 106, 0.35)',
    boxShadow: '0 0 32px rgba(74, 186, 106, 0.15)',
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: '#4aba6a',
    margin: 0,
  },
  emptySubtitle: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.35)',
    margin: 0,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  emptyDescription: {
    fontSize: 13,
    color: 'var(--text-muted)',
    lineHeight: 1.6,
    margin: '8px 0 0',
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
  speakBtn: {
    marginLeft: 'auto',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    padding: 4,
    transition: 'color 0.15s',
  } as React.CSSProperties,
  bubbleSpeakBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    padding: 0,
  } as React.CSSProperties,
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
