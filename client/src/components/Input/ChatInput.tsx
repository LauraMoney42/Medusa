import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type KeyboardEvent,
  type ClipboardEvent,
} from 'react';
import { getSocket } from '../../socket';
import { uploadImage } from '../../api';
import { useSessionStore } from '../../stores/sessionStore';
import { useImageDropStore } from '../../stores/imageDropStore';
import { useDraftStore } from '../../stores/draftStore';
import ImagePreview from './ImagePreview';
import ScreenshotButton from './ScreenshotButton';

interface ChatInputProps {
  sessionId: string;
  botName?: string;
}

export default function ChatInput({ sessionId, botName }: ChatInputProps) {
  const getDraft = useDraftStore((s) => s.getDraft);
  const setDraft = useDraftStore((s) => s.setDraft);
  const clearDraft = useDraftStore((s) => s.clearDraft);

  // DM3: Restore draft when switching sessions
  const [text, setText] = useState(() => getDraft(sessionId));
  const [images, setImages] = useState<{ file: File; preview: string }[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // DM3: When sessionId changes, restore the draft for the new session
  useEffect(() => {
    setText(getDraft(sessionId));
    // Reset textarea height on session switch
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  // getDraft is stable (zustand selector), sessionId is the real dep here
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const status = useSessionStore((s) => s.statuses[sessionId] ?? 'idle');
  const isBusy = status === 'busy';

  // Consume images dropped via global drag-and-drop
  const pendingImages = useImageDropStore((s) => s.pendingImages);
  const consumeImages = useImageDropStore((s) => s.consumeImages);

  useEffect(() => {
    if (pendingImages.length === 0) return;
    const consumed = consumeImages();
    if (consumed.length > 0) {
      setImages((prev) => [...prev, ...consumed]);
    }
  }, [pendingImages, consumeImages]);

  const handleScreenshot = useCallback((file: File, preview: string) => {
    setImages((prev) => [...prev, { file, preview }]);
  }, []);

  const send = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;

    // Upload images first
    const uploadedPaths: string[] = [];
    for (const img of images) {
      try {
        const { filePath } = await uploadImage(img.file);
        uploadedPaths.push(filePath);
      } catch (err) {
        console.error('Image upload failed:', err);
      }
    }

    const socket = getSocket();
    socket.emit('message:send', {
      sessionId,
      text: trimmed,
      images: uploadedPaths.length > 0 ? uploadedPaths : undefined,
    });

    // Cancel any pending debounced setDraft — must happen before clearDraft
    // or the debounce fires after the clear and re-saves the stale text
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    // Clear the draft after successful emit
    clearDraft(sessionId);

    setText('');
    // Revoke blob URLs to prevent memory leaks
    images.forEach((img) => URL.revokeObjectURL(img.preview));
    setImages([]);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, images, sessionId, clearDraft]);

  const handleAbort = useCallback(() => {
    const socket = getSocket();
    socket.emit('message:abort', { sessionId });
  }, [sessionId]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isBusy) send();
    }
  };

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
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
  };

  const removeImage = (index: number) => {
    setImages((prev) => {
      const removed = prev[index];
      URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  // Auto-resize textarea — grows to MAX_HEIGHT then scrolls internally
  const MAX_HEIGHT = 150;
  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  };

  // Keep input visible when mobile keyboard opens
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const scrollIntoView = () => {
      textareaRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    };
    vv.addEventListener('resize', scrollIntoView);
    return () => vv.removeEventListener('resize', scrollIntoView);
  }, []);

  return (
    <div style={styles.wrapper}>
      {/* Image previews */}
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

      <div style={styles.inputRow}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            const val = e.target.value;
            setText(val);
            // DM2: Debounced draft save (300ms) — clear draft if input emptied
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => {
              if (val) {
                setDraft(sessionId, val);
              } else {
                clearDraft(sessionId);
              }
            }, 300);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onInput={handleInput}
          placeholder={isBusy ? `${botName || 'Claude'} is thinking...` : `Message ${botName || 'Claude'}...`}
          disabled={false}
          rows={1}
          style={styles.textarea}
        />

        <ScreenshotButton onCapture={handleScreenshot} disabled={isBusy} />

        {isBusy ? (
          <button
            onClick={handleAbort}
            style={styles.abortBtn}
            title="Abort"
          >
            <span style={styles.abortSquare} />
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!text.trim() && images.length === 0}
            style={{
              ...styles.sendBtn,
              opacity: text.trim() || images.length > 0 ? 1 : 0.4,
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
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    padding: '8px 16px 16px',
    background: 'transparent',
    flexShrink: 0,
  },
  imageRow: {
    display: 'flex',
    gap: 8,
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  inputRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 8,
    background: '#232325',
    borderRadius: 'var(--radius)',
    padding: '10px 14px',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.15)',
  } as React.CSSProperties,
  textarea: {
    flex: 1,
    resize: 'none',
    background: 'transparent',
    color: 'var(--text-primary)',
    fontSize: 15,
    lineHeight: 1.5,
    maxHeight: 150,
    minHeight: 24,
    overflowY: 'hidden', // JS toggles to 'auto' when at max height
  } as React.CSSProperties,
  sendBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'var(--accent)',
    color: '#fff',
    flexShrink: 0,
    transition: 'opacity 0.15s, box-shadow 0.3s',
    boxShadow: '0 0 12px rgba(26, 122, 60, 0.3), 0 0 24px rgba(26, 122, 60, 0.1)',
  },
  abortBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'var(--danger)',
    flexShrink: 0,
    boxShadow: '0 0 8px rgba(192, 57, 43, 0.25)',
  },
  abortSquare: {
    display: 'block',
    width: 12,
    height: 12,
    background: '#fff',
    borderRadius: 2,
  },
};
