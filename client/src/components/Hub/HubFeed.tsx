import { useCallback, useEffect, useRef, useState } from 'react';
import { useHubStore } from '../../stores/hubStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useImageDropStore } from '../../stores/imageDropStore';
import { getSocket } from '../../socket';
import { uploadImage } from '../../api';
import HubMessage from './HubMessage';
import ImagePreview from '../Input/ImagePreview';
import ScreenshotButton from '../Input/ScreenshotButton';
import MentionAutocomplete from './MentionAutocomplete';

const HUB_MAX_HEIGHT = 150;

interface HubFeedProps {
  onMenuToggle?: () => void;
}

/**
 * Extract the @mention query from input at the cursor position.
 * Returns text after @ if currently typing a mention, or null.
 */
function getMentionQuery(input: string, cursor: number): string | null {
  const before = input.slice(0, cursor);
  const atIndex = before.lastIndexOf('@');
  if (atIndex === -1) return null;

  // @ must be at start or preceded by whitespace
  if (atIndex > 0 && !/\s/.test(before[atIndex - 1])) return null;

  const query = before.slice(atIndex + 1);

  // Allow multi-word bot names (e.g. "Full Stack Dev") — up to 4 words
  if (query.split(/\s+/).length > 4) return null;

  return query;
}

export default function HubFeed({ onMenuToggle }: HubFeedProps) {
  const messages = useHubStore((s) => s.messages);
  const markAllSeen = useHubStore((s) => s.markAllSeen);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeView = useSessionStore((s) => s.activeView);
  const sessions = useSessionStore((s) => s.sessions);

  const [input, setInput] = useState('');
  const [images, setImages] = useState<{ file: File; preview: string }[]>([]);
  const [cursorPos, setCursorPos] = useState(0);
  const [mentionVisible, setMentionVisible] = useState(false);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const hubTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Consume images dropped via global drag-and-drop (only when Hub is active)
  const pendingImages = useImageDropStore((s) => s.pendingImages);
  const consumeImages = useImageDropStore((s) => s.consumeImages);

  useEffect(() => {
    if (activeView !== 'hub') return;
    if (pendingImages.length === 0) return;
    const consumed = consumeImages();
    if (consumed.length > 0) {
      setImages((prev) => [...prev, ...consumed]);
    }
  }, [pendingImages, consumeImages, activeView]);

  // Mark all messages as seen when the hub is visible
  useEffect(() => {
    markAllSeen();
  }, [messages.length, markAllSeen]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const removeImage = (index: number) => {
    setImages((prev) => {
      const removed = prev[index];
      URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  // @-mention autocomplete: build candidates and filtered list
  const mentionCandidates = [
    ...sessions.map((s) => s.name),
    'You',
    'all',
  ];

  const mentionQuery = getMentionQuery(input, cursorPos);
  const mentionFiltered = mentionQuery !== null
    ? mentionCandidates.filter((name) =>
        name.toLowerCase().startsWith(mentionQuery.toLowerCase())
      )
    : [];

  // Show/hide autocomplete based on whether we have a query + matches
  useEffect(() => {
    setMentionVisible(mentionQuery !== null && mentionFiltered.length > 0);
    setMentionSelectedIndex(0);
  }, [mentionQuery, mentionFiltered.length]);

  const handleMentionSelect = useCallback((newValue: string, newCursorPos: number) => {
    setInput(newValue);
    setCursorPos(newCursorPos);
    setMentionVisible(false);
    // Move textarea cursor to new position
    requestAnimationFrame(() => {
      if (hubTextareaRef.current) {
        hubTextareaRef.current.selectionStart = newCursorPos;
        hubTextareaRef.current.selectionEnd = newCursorPos;
        hubTextareaRef.current.focus();
      }
    });
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && images.length === 0) return;

    // Upload images first
    const uploadedPaths: string[] = [];
    for (const img of images) {
      try {
        const { filePath } = await uploadImage(img.file);
        uploadedPaths.push(filePath);
      } catch (err) {
        console.error('Hub image upload failed:', err);
      }
    }

    const socket = getSocket();
    socket.emit('hub:post', {
      // sessionId is optional for user posts — server handles missing session gracefully
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      text: text || '(image)',
      from: 'User',
      ...(uploadedPaths.length > 0 ? { images: uploadedPaths } : {}),
    });

    setInput('');
    // Revoke preview URLs before clearing
    for (const img of images) {
      URL.revokeObjectURL(img.preview);
    }
    setImages([]);
    setMentionVisible(false);
    // Reset textarea height after send
    if (hubTextareaRef.current) {
      hubTextareaRef.current.style.height = 'auto';
      hubTextareaRef.current.style.overflowY = 'hidden';
    }
  }, [input, images, activeSessionId]);

  // Auto-resize Hub textarea as user types.
  // Accepts the FormEvent param so TypeScript recognises this as a proper event handler
  // and doesn't incorrectly flag it as "declared but never read" (TS6133).
  const handleHubInput = useCallback((_e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = hubTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, HUB_MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > HUB_MAX_HEIGHT ? 'auto' : 'hidden';
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    setCursorPos(e.target.selectionStart ?? e.target.value.length);
  }, []);

  const handleInputClick = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;
    setCursorPos(target.selectionStart ?? 0);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Let mention autocomplete consume arrow/tab/enter/escape keys first
      if (mentionVisible && mentionFiltered.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setMentionSelectedIndex((prev) => (prev + 1) % mentionFiltered.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setMentionSelectedIndex((prev) => (prev - 1 + mentionFiltered.length) % mentionFiltered.length);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          const name = mentionFiltered[mentionSelectedIndex];
          if (name && mentionQuery !== null) {
            const atStart = cursorPos - mentionQuery.length - 1;
            const before = input.slice(0, atStart);
            const after = input.slice(cursorPos);
            const newValue = `${before}@${name} ${after}`;
            const newCursor = before.length + name.length + 2;
            handleMentionSelect(newValue, newCursor);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setMentionVisible(false);
          return;
        }
      }

      // Normal send on Enter (without shift)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, mentionVisible, mentionFiltered, mentionSelectedIndex, mentionQuery, cursorPos, input, handleMentionSelect],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData.items;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        const newImages = imageFiles.map((file) => ({
          file,
          preview: URL.createObjectURL(file),
        }));
        setImages((prev) => [...prev, ...newImages]);
      }
    },
    [],
  );

  // Screenshot capture handler — adds captured image to staged images
  const handleScreenshot = useCallback((file: File, preview: string) => {
    setImages((prev) => [...prev, { file, preview }]);
  }, []);

  const canSend = input.trim() || images.length > 0;

  return (
    <div style={styles.container}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <div className="mobile-header" style={styles.mobileHeader}>
          <button onClick={onMenuToggle} style={styles.menuBtn}>
            &#9776;
          </button>
        </div>
        <span style={styles.title}>Hub</span>
      </div>

      {/* Message feed */}
      <div style={styles.feed}>
        {messages.length === 0 ? (
          <div style={styles.empty}>
            <p style={styles.emptyText}>No hub messages yet</p>
            <p style={styles.emptyHint}>
              Bots will post here when they need help or want to coordinate.
              You can also post messages to the hub.
            </p>
          </div>
        ) : (
          messages.map((msg) => <HubMessage key={msg.id} message={msg} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area — always visible; no session required to post */}
      <div style={styles.inputWrapper}>
        {/* Staged image previews */}
        {images.length > 0 && (
          <div style={styles.imageRow}>
            {images.map((img, i) => (
              <ImagePreview
                key={i}
                src={img.preview}
                onRemove={() => removeImage(i)}
              />
            ))}
          </div>
        )}
        <div style={styles.inputAreaOuter}>
          {/* @-mention autocomplete popup */}
          <MentionAutocomplete
            inputValue={input}
            cursorPosition={cursorPos}
            onSelect={handleMentionSelect}
            onDismiss={() => setMentionVisible(false)}
            visible={mentionVisible}
          />
          <div style={styles.inputArea}>
            <textarea
              ref={hubTextareaRef}
              value={input}
              onChange={handleInputChange}
              onClick={handleInputClick}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onInput={handleHubInput}
              placeholder="Post to the Hub... (type @ to mention)"
              rows={1}
              style={styles.textarea}
            />
            <ScreenshotButton
              onCapture={handleScreenshot}
              disabled={false}
            />
            <button
              onClick={handleSend}
              disabled={!canSend}
              style={{
                ...styles.sendBtn,
                opacity: canSend ? 1 : 0.4,
              }}
              title="Send"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
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

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--bg-primary)',
    minWidth: 0,
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 16px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(26, 26, 28, 0.75)',
    backdropFilter: 'blur(20px) saturate(1.2)',
    WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
    flexShrink: 0,
  } as React.CSSProperties,
  mobileHeader: {
    alignItems: 'center',
  },
  menuBtn: {
    fontSize: 20,
    padding: '4px 8px',
    color: 'var(--text-secondary)',
  },
  title: {
    fontSize: 15,
    fontWeight: 600,
    color: '#4aba6a',
  },
  feed: {
    flex: 1,
    overflow: 'auto',
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-secondary)',
  },
  emptyHint: {
    fontSize: 13,
    color: 'var(--text-muted)',
    textAlign: 'center',
    maxWidth: 340,
    lineHeight: 1.5,
  } as React.CSSProperties,
  inputWrapper: {
    borderTop: '1px solid rgba(255, 255, 255, 0.08)',
    background: '#1a1a1c',
    flexShrink: 0,
    padding: '10px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  imageRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  inputAreaOuter: {
    position: 'relative',
  } as React.CSSProperties,
  inputArea: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 8,
  },
  textarea: {
    flex: 1,
    resize: 'none',
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 'var(--radius-md, 10px)',
    padding: '8px 12px',
    fontSize: 14,
    color: '#e5e5ea',
    caretColor: '#e5e5ea',
    outline: 'none',
    lineHeight: 1.5,
    minHeight: 36,
    maxHeight: 150,
    overflowY: 'hidden', // JS toggles to 'auto' when at max height
    display: 'block',
  } as React.CSSProperties,
  sendBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'rgba(26, 122, 60, 0.18)',
    color: '#a8d8b8',
    border: '1px solid rgba(26, 122, 60, 0.25)',
    flexShrink: 0,
    cursor: 'pointer',
    transition: 'opacity 0.15s, box-shadow 0.3s, background 0.15s',
    boxShadow: '0 0 12px rgba(26, 122, 60, 0.15), 0 0 24px rgba(26, 122, 60, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
  } as React.CSSProperties,
  noSessionArea: {
    display: 'flex',
    alignItems: 'center',
    padding: '10px 16px',
    borderTop: '1px solid rgba(255, 255, 255, 0.08)',
    background: '#1a1a1c',
    flexShrink: 0,
  },
  noSession: {
    fontSize: 13,
    color: 'var(--text-muted)',
    padding: '8px 0',
  },
};
