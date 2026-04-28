import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type KeyboardEvent,
  type ClipboardEvent,
} from 'react';
import { getSocket } from '../../socket';
import { uploadImage, uploadFile } from '../../api';
import { useSessionStore } from '../../stores/sessionStore';
import { useFileDropStore, type FileEntry } from '../../stores/fileDropStore';
import { useDraftStore } from '../../stores/draftStore';
import { useInputHistoryStore } from '../../stores/inputHistoryStore';
import AttachmentPreview from './AttachmentPreview';
import ScreenshotButton from './ScreenshotButton';

interface ChatInputProps {
  sessionId: string;
  botName?: string;
}

export default function ChatInput({ sessionId, botName }: ChatInputProps) {
  const getDraft = useDraftStore((s) => s.getDraft);
  const setDraft = useDraftStore((s) => s.setDraft);
  const clearDraft = useDraftStore((s) => s.clearDraft);

  const historyUp = useInputHistoryStore((s) => s.up);
  const historyDown = useInputHistoryStore((s) => s.down);
  const historyPush = useInputHistoryStore((s) => s.push);
  const historyReset = useInputHistoryStore((s) => s.resetNav);

  // DM3: Restore draft when switching sessions
  const [text, setText] = useState(() => getDraft(sessionId));
  const [attachments, setAttachments] = useState<FileEntry[]>([]);
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

  // Consume files dropped via global drag-and-drop
  const pendingFiles = useFileDropStore((s) => s.pendingFiles);
  const consumeFiles = useFileDropStore((s) => s.consumeFiles);

  useEffect(() => {
    if (pendingFiles.length === 0) return;
    const consumed = consumeFiles();
    if (consumed.length > 0) {
      setAttachments((prev) => [...prev, ...consumed]);
    }
  }, [pendingFiles, consumeFiles]);

  const handleScreenshot = useCallback((file: File, preview: string) => {
    setAttachments((prev) => [...prev, { file, preview, isImage: true }]);
  }, []);

  const send = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    // Split attachments into images and files, upload accordingly
    const imagePaths: string[] = [];
    const filePaths: string[] = [];
    for (const att of attachments) {
      try {
        if (att.isImage) {
          const { filePath } = await uploadImage(att.file);
          imagePaths.push(filePath);
        } else {
          const { filePath } = await uploadFile(att.file);
          filePaths.push(filePath);
        }
      } catch (err) {
        console.error('Upload failed:', err);
      }
    }

    const socket = getSocket();
    socket.emit('message:send', {
      sessionId,
      text: trimmed,
      images: imagePaths.length > 0 ? imagePaths : undefined,
      files: filePaths.length > 0 ? filePaths : undefined,
    });

    // Cancel any pending debounced setDraft — must happen before clearDraft
    // or the debounce fires after the clear and re-saves the stale text
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    // Clear the draft after successful emit
    clearDraft(sessionId);
    historyPush(sessionId, trimmed);
    historyReset(sessionId);

    setText('');
    // Revoke blob URLs to prevent memory leaks
    attachments.forEach((att) => {
      if (att.preview) URL.revokeObjectURL(att.preview);
    });
    setAttachments([]);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, attachments, sessionId, clearDraft]);

  const handleAbort = useCallback(() => {
    const socket = getSocket();
    socket.emit('message:abort', { sessionId });
  }, [sessionId]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Input history navigation (bash-style up/down arrow)
    if (e.key === 'ArrowUp' && !e.shiftKey) {
      const el = e.currentTarget;
      if (el.selectionStart === 0 && el.selectionEnd === 0) {
        const prev = historyUp(sessionId, text);
        if (prev !== null) {
          e.preventDefault();
          setText(prev);
          // Place cursor at start so next Up press works immediately
          requestAnimationFrame(() => {
            el.selectionStart = 0;
            el.selectionEnd = 0;
          });
        }
      }
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey) {
      const el = e.currentTarget;
      if (el.selectionStart === el.value.length) {
        const next = historyDown(sessionId);
        if (next !== null) {
          e.preventDefault();
          setText(next);
          // Place cursor at end so next Down press works immediately
          requestAnimationFrame(() => {
            el.selectionStart = el.value.length;
            el.selectionEnd = el.value.length;
          });
        }
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isBusy) send();
    }
  };

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    const imageFiles: File[] = [];
    let hasText = false;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type === 'text/plain' || items[i].type === 'text/html') {
        hasText = true;
      } else if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }

    // Only treat as image attachment when there is NO text in the clipboard.
    // When both image and text are present (e.g. copying from a browser), the
    // image is a visual snapshot of the selection — the user wants the text,
    // not a screenshot. Let the default paste behaviour insert the plain text.
    if (imageFiles.length > 0 && !hasText) {
      e.preventDefault();
      const newEntries: FileEntry[] = imageFiles.map((file) => ({
        file,
        preview: URL.createObjectURL(file),
        isImage: true,
      }));
      setAttachments((prev) => [...prev, ...newEntries]);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => {
      const removed = prev[index];
      if (removed.preview) URL.revokeObjectURL(removed.preview);
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
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div style={styles.imageRow}>
          {attachments.map((att, i) => (
            <AttachmentPreview
              key={i}
              entry={att}
              onRemove={() => removeAttachment(i)}
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
            historyReset(sessionId);
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
            disabled={!text.trim() && attachments.length === 0}
            style={{
              ...styles.sendBtn,
              opacity: text.trim() || attachments.length > 0 ? 1 : 0.4,
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
