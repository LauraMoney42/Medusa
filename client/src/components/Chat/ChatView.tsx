import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore } from '../../stores/chatStore';
import { useTtsStore } from '../../stores/ttsStore';
import { getSocket } from '../../socket';
import MessageBubble from './MessageBubble';
import ChatHeaderControls from './ChatHeaderControls';
import ScreenshotButton from '../Input/ScreenshotButton';
import MicButton from '../Input/MicButton';
import VoiceBar from '../Voice/VoiceBar';
import { useDictationInsert } from '../../hooks/useDictationInsert';
import TokenRing from '../Usage/TokenRing';
import { useProviderStore } from '../../stores/providerStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { isFollowupMessage, type ChatMessage } from '../../types/message';
import {
  uploadImage,
  synthesizeSpeech,
  fetchTtsStatus,
  setProvider,
  updateSession,
} from '../../api';

interface ChatViewProps {
  onMenuToggle?: () => void;
  onNewChat?: () => void;
}

/** Last path segment of a folder, for the header chip. */
function basename(dir: string): string {
  const parts = (dir ?? '').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || dir || '';
}

/**
 * The single chat view. One chat = one folder + one provider + one model +
 * one engine, so there is no agent selector: the left rail's selection is the
 * only thing that decides which chat this renders.
 */
export default function ChatView({ onMenuToggle, onNewChat }: ChatViewProps) {
  // The shared socket and its listeners are set up once in AuthenticatedApp.
  // Calling useSocket() here would register a second set on the same socket
  // and double every bubble.
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const statuses = useSessionStore((s) => s.statuses);
  const messages = useChatStore((s) => s.messages);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const streamingId = useChatStore((s) => s.streamingMessageId);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const isBusy = activeSession ? statuses[activeSession.id] === 'busy' : false;

  const [text, setText] = useState('');
  const [images, setImages] = useState<{ file: File; preview: string }[]>();
  /** Message ids whose tool cards the user has expanded from the footer. */
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);

  // Voice-out (TTS): preferences live in the shared store, synced with Settings.
  const speak = useTtsStore((s) => s.speak);
  const setSpeak = useTtsStore((s) => s.setSpeak);
  const voice = useTtsStore((s) => s.voice);
  const speed = useTtsStore((s) => s.speed);
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const voiceMode = useVoiceStore((s) => s.mode);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prevStreamingRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeSession) return;
    loadMessages(activeSession.id).catch(console.error);
  }, [activeSession, loadMessages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [text]);

  const chatMessages = useMemo(
    () => (activeSession ? messages[activeSession.id] ?? [] : []),
    [activeSession, messages],
  );

  useEffect(() => {
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages]);

  useEffect(() => {
    let cancelled = false;
    fetchTtsStatus()
      .then((s) => {
        if (!cancelled) setTtsAvailable(s.enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Speak a reply: strip markdown and code, cap the length for snappy speech.
  const playTTS = useCallback(
    async (raw: string) => {
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
    },
    [voice, speed],
  );

  useEffect(() => {
    const prev = prevStreamingRef.current;
    prevStreamingRef.current = streamingId;
    if (!prev || streamingId || !speak || !activeSession) return;
    const msg = (messages[activeSession.id] ?? []).find((m) => m.id === prev);
    if (msg && msg.role !== 'user' && msg.text?.trim()) void playTTS(msg.text);
  }, [streamingId, speak, activeSession, messages, playTTS]);

  const toggleSpeak = useCallback(() => {
    const next = !speak;
    setSpeak(next);
    if (!next && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, [speak, setSpeak]);

  /** Send `body`, uploading any attached images first. */
  const send = useCallback(
    async (body: string, attachments: { file: File; preview: string }[]) => {
      if (!activeSession) return;
      const socket = getSocket();
      if (!socket.connected) {
        console.warn('[chat] Socket disconnected, message queued for reconnect');
      }
      const uploadedPaths: string[] = [];
      for (const img of attachments) {
        try {
          const { filePath } = await uploadImage(img.file);
          uploadedPaths.push(filePath);
        } catch (err) {
          console.error('Image upload failed:', err);
        }
      }
      socket.emit('message:send', {
        sessionId: activeSession.id,
        text: body,
        ...(uploadedPaths.length > 0 ? { images: uploadedPaths } : {}),
      });
    },
    [activeSession],
  );

  const handleSendMessage = useCallback(async () => {
    if (!activeSession) return;
    if (!text.trim() && (!images || images.length === 0)) return;
    const body = text.trim();
    const attachments = images ?? [];
    setText('');
    setImages([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    await send(body, attachments);
  }, [text, images, activeSession, send]);

  const handleAbort = useCallback(() => {
    if (!activeSession) return;
    getSocket().emit('message:abort', { sessionId: activeSession.id });
  }, [activeSession]);

  /**
   * Regenerate: resend the user message that preceded this reply. The engine
   * treats it as a fresh turn, which is the same thing the user would get by
   * retyping it.
   */
  const handleRegenerate = useCallback(
    (assistantIndex: number) => {
      for (let i = assistantIndex - 1; i >= 0; i--) {
        const candidate = chatMessages[i];
        if (candidate.role === 'user') {
          void send(candidate.text, []);
          return;
        }
      }
    },
    [chatMessages, send],
  );

  const handleCopy = useCallback((msg: ChatMessage) => {
    void navigator.clipboard.writeText(msg.text).then(
      () => {
        setCopiedId(msg.id);
        window.setTimeout(() => setCopiedId((id) => (id === msg.id ? null : id)), 1200);
      },
      (err) => console.error('Copy failed:', err),
    );
  }, []);

  /**
   * True when running inside Tauri at all. Note this does NOT mean
   * `window.__TAURI__.shell.open` exists -- `withGlobalTauri` only injects
   * the core `invoke`/`event`/`path`/`window` bindings, not per-plugin JS
   * wrappers (those need the separate `@tauri-apps/plugin-*` npm package,
   * which this app never added for shell or dialog). Reveal-in-Finder goes
   * through `core.invoke` instead, same pattern as NewChatModal's folder
   * picker.
   */
  const getTauriInvoke = (): ((cmd: string, args?: unknown) => Promise<unknown>) | null => {
    const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__;
    const invoke = tauri?.core?.invoke;
    return typeof invoke === 'function' ? (invoke as (cmd: string, args?: unknown) => Promise<unknown>) : null;
  };

  /**
   * Folder chip click: under Tauri, reveal the chat's working directory in
   * Finder. Tries the Rust `reveal_in_finder` command first (desktop/
   * src-tauri/src/main.rs, no capability grant needed for a plain app
   * command), then the shell plugin's own `plugin:shell|open` invoke command
   * (granted by `shell:allow-open`) as a second path. In a plain browser, or
   * if both fail, copies the path to the clipboard instead and reuses the
   * copiedId toast used by message Copy buttons.
   */
  const handleFolderChipClick = useCallback(() => {
    if (!activeSession) return;
    const dir = activeSession.workingDir;
    const invoke = getTauriInvoke();

    const copyPath = () => {
      void navigator.clipboard.writeText(dir).then(
        () => {
          setCopiedId('folder-chip');
          window.setTimeout(() => setCopiedId((id) => (id === 'folder-chip' ? null : id)), 1200);
        },
        (err) => console.error('Copy failed:', err),
      );
    };

    if (!invoke) {
      copyPath();
      return;
    }

    invoke('reveal_in_finder', { path: dir }).catch((err) => {
      console.warn('[folder-chip] reveal_in_finder failed, trying shell plugin:', err);
      invoke('plugin:shell|open', { path: dir }).catch((err2) => {
        console.warn('[folder-chip] shell plugin open also failed, copying path instead:', err2);
        copyPath();
      });
    });
  }, [activeSession]);

  const handleScreenshot = useCallback((file: File, preview: string) => {
    setImages((prev) => [...(prev ?? []), { file, preview }]);
  }, []);

  const handleTranscript = useDictationInsert(setText);

  const handleRemoveImage = useCallback((idx: number) => {
    setImages((prev) => {
      if (!prev) return prev;
      const next = prev.filter((_, i) => i !== idx);
      return next.length === 0 ? undefined : next;
    });
  }, []);

  // --- Provider and model, directly under the input ---

  const activeProviderId = useProviderStore((s) => s.activeProviderId);
  const setActiveProviderId = useProviderStore((s) => s.setActiveProviderId);
  const providers = useProviderStore((s) => s.providers);
  const fetchProviderList = useProviderStore((s) => s.fetchProviders);
  const fetchProviderModels = useProviderStore((s) => s.fetchModels);
  const modelsFor = useProviderStore((s) => s.modelsFor);

  // The chat's own provider wins over the global setting: one chat, one provider.
  const providerId = activeSession?.providerId ?? activeProviderId;
  const modelOptions = modelsFor(providerId);
  const updateSessionInStore = useSessionStore((s) => s.updateSession);

  useEffect(() => {
    void fetchProviderList();
  }, [fetchProviderList]);

  useEffect(() => {
    void fetchProviderModels(providerId);
  }, [providerId, fetchProviderModels]);

  const handleProviderChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value;
      setActiveProviderId(next);
      if (activeSession) {
        // Switching provider invalidates the model: it belonged to the old one.
        await updateSessionInStore(activeSession.id, { providerId: next, model: null }).catch(
          console.error,
        );
      }
      // Keep the server-wide default in step so the next new chat inherits it.
      await setProvider(next).catch(() => {});
    },
    [activeSession, setActiveProviderId, updateSessionInStore],
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!activeSession) return;
      void updateSession(activeSession.id, { model: e.target.value || null }).catch(
        console.error,
      );
      void updateSessionInStore(activeSession.id, { model: e.target.value || null }).catch(
        () => {},
      );
    },
    [activeSession, updateSessionInStore],
  );

  if (!activeSession) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <img src="/MedusaIcon.png" alt="" style={styles.emptyIcon} />
          <p style={styles.emptyTitle}>No chats yet</p>
          <p style={styles.emptyDescription}>
            A chat is one project folder, one provider, one model, one engine.
          </p>
          {onNewChat && (
            <button onClick={onNewChat} style={styles.emptyCta}>
              New chat
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header: menu, title, folder chip, then the panel icons at the far right */}
      <div style={styles.header}>
        <button onClick={onMenuToggle} style={styles.menuBtn} title="Menu">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        <span style={styles.chatTitle}>{activeSession.name}</span>

        <button
          type="button"
          onClick={handleFolderChipClick}
          style={styles.folderChip}
          title={
            copiedId === 'folder-chip'
              ? 'Copied'
              : `${activeSession.workingDir} (click to ${getTauriInvoke() ? 'open in Finder' : 'copy path'})`
          }
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          {copiedId === 'folder-chip' ? 'Copied' : basename(activeSession.workingDir)}
        </button>

        <div style={styles.headerRight}>
          {ttsAvailable && (
            <button
              onClick={toggleSpeak}
              title={speak ? 'Mute replies' : 'Speak replies'}
              style={{ ...styles.speakBtn, color: speak ? '#4aba6a' : 'var(--text-muted)' }}
            >
              {speak ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              )}
            </button>
          )}
          <ChatHeaderControls />
        </div>
      </div>

      {/* Messages */}
      <div ref={messageListRef} style={styles.messageList}>
        {chatMessages.length === 0 ? (
          <div style={styles.emptyState}>
            <img src="/MedusaIcon.png" alt="" style={styles.emptyIcon} />
            <p style={styles.emptyTitle}>Medusa</p>
            <p style={styles.emptyDescription}>
              Working in <code style={styles.emptyPath}>{activeSession.workingDir}</code>. Ask
              for a feature, a fix, or a review.
            </p>
          </div>
        ) : (
          chatMessages.map((msg, i) => {
            // Event-driven subagent follow-ups (S14-B) render as a compact
            // system chip, not a chat bubble. MessageBubble stays untouched
            // (S6 owns it), so this branch bypasses it entirely rather than
            // teaching it a new role.
            if (isFollowupMessage(msg)) {
              return (
                <div key={msg.id} style={styles.followupChip}>
                  <span style={styles.followupIcon}>↻</span>
                  <span style={styles.followupText}>{msg.text}</span>
                </div>
              );
            }
            const toolCount = msg.toolUses?.length ?? 0;
            const toolsOpen = openTools[msg.id] ?? false;
            return (
              <div key={msg.id} style={styles.messageGroup}>
                <MessageBubble
                  // MessageBubble stays untouched (S6 owns it), so the footer's
                  // disclosure works by handing it a message with its tool
                  // cards withheld while the section is collapsed.
                  message={toolsOpen || toolCount === 0 ? msg : { ...msg, toolUses: undefined }}
                  botName={activeSession.name}
                  onSpeak={ttsAvailable ? playTTS : undefined}
                />
                {msg.role === 'assistant' && !msg.isStreaming && (
                  <div
                    style={{
                      ...styles.footer,
                      justifyContent: 'flex-start',
                    }}
                  >
                    <span style={styles.footerTime}>
                      {new Date(msg.timestamp).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}
                    </span>
                    <button style={styles.footerBtn} onClick={() => handleCopy(msg)}>
                      {copiedId === msg.id ? 'Copied' : 'Copy'}
                    </button>
                    <button style={styles.footerBtn} onClick={() => handleRegenerate(i)}>
                      Regenerate
                    </button>
                    {toolCount > 0 && (
                      <button
                        style={styles.footerDisclosure}
                        aria-expanded={toolsOpen}
                        onClick={() =>
                          setOpenTools((prev) => ({ ...prev, [msg.id]: !toolsOpen }))
                        }
                      >
                        {toolsOpen ? '▾' : '▸'} Show tool calls &amp; activity ({toolCount}{' '}
                        {toolCount === 1 ? 'line' : 'lines'})
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Input area */}
      <div style={styles.inputContainer}>
        <VoiceBar sessionId={activeSession.id} inputEmpty={text.trim().length === 0} />

        {images && images.length > 0 && (
          <div style={styles.imageRow}>
            {images.map((img, idx) => (
              <div key={idx} style={styles.imagePreview}>
                <img src={img.preview} alt="Attached" style={styles.imageThumb} />
                <button onClick={() => handleRemoveImage(idx)} style={styles.imageRemove} title="Remove">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={styles.inputRow}>
          <ScreenshotButton onCapture={handleScreenshot} disabled={false} />

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSendMessage();
              }
            }}
            placeholder="Ask Medusa..."
            style={styles.textarea}
          />

          {voiceMode === 'off' && (
            <MicButton onTranscript={handleTranscript} disabled={false} compact />
          )}

          {isBusy ? (
            <button onClick={handleAbort} style={styles.abortBtn} title="Stop">
              <span style={styles.abortSquare} />
            </button>
          ) : (
            <button
              onClick={() => void handleSendMessage()}
              disabled={!text.trim() && (!images || images.length === 0)}
              style={styles.sendBtn}
              title="Send (Enter)"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          )}
        </div>

        {/* Thin accent progress bar while a turn is running */}
        <div style={styles.progressTrack}>
          {isBusy && <div className="medusa-turn-progress" style={styles.progressBar} />}
        </div>

        {/* Model selector directly under the input, with the usage ring */}
        <div style={styles.bottomBar}>
          <div style={styles.bottomBarLeft}>
            <select
              value={providerId}
              onChange={(e) => void handleProviderChange(e)}
              aria-label="Provider"
              style={styles.picker}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <span style={styles.pickerDivider}>/</span>
            <select
              value={activeSession.model ?? ''}
              onChange={handleModelChange}
              aria-label="Model"
              style={styles.picker}
            >
              <option value="">Auto</option>
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                  {m.cheap ? ' · cheap' : ''}
                </option>
              ))}
            </select>
          </div>
          <div style={styles.bottomBarRight}>
            <TokenRing popoverDirection="up" />
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
    background: 'var(--glass-bg-heavy)',
    minWidth: 0,
    // Without minHeight:0 a flex item defaults to min-height:auto, so the
    // message list grows to its content and pushes the input bar (and the
    // model picker under it) past the bottom of the viewport.
    minHeight: 0,
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  menuBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: 2,
    display: 'flex',
    alignItems: 'center',
  },
  chatTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  folderChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '2px 8px',
    borderRadius: 999,
    border: '1px solid var(--border-glow)',
    background: 'rgba(26, 122, 60, 0.10)',
    color: '#4aba6a',
    fontSize: 11,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    cursor: 'pointer',
  },
  headerRight: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    // Clears the fixed CaffeineToggle (top:12, right:14).
    paddingRight: 104,
  },
  speakBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    padding: 4,
  },
  messageList: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    minHeight: 0,
  },
  messageGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  // S14-B follow-up chip: a compact system line, not a bubble, so an
  // unprompted "the agent finished" reads as ambient status rather than a
  // second voice in the conversation.
  followupChip: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'center',
    margin: '4px 0',
    padding: '4px 12px',
    fontSize: 11.5,
    color: 'var(--text-muted)',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 999,
    maxWidth: '80%',
  },
  followupIcon: {
    flexShrink: 0,
    opacity: 0.7,
  },
  followupText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '2px 4px 6px',
    borderTop: '1px solid rgba(26, 122, 60, 0.14)',
    marginTop: 4,
  },
  footerTime: {
    fontSize: 10.5,
    color: 'var(--text-muted)',
    fontVariantNumeric: 'tabular-nums',
  },
  footerBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    fontSize: 11,
    cursor: 'pointer',
    padding: 0,
  },
  footerDisclosure: {
    background: 'none',
    border: 'none',
    color: '#4aba6a',
    fontSize: 11,
    cursor: 'pointer',
    padding: 0,
    marginLeft: 'auto',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    margin: 'auto',
    padding: '40px 32px',
    maxWidth: 420,
    textAlign: 'center',
  },
  emptyIcon: {
    width: 68,
    height: 68,
    borderRadius: '50%',
    border: '1.5px solid rgba(74, 186, 106, 0.35)',
    boxShadow: '0 0 32px rgba(74, 186, 106, 0.15)',
    marginBottom: 4,
  },
  emptyTitle: { fontSize: 20, fontWeight: 700, color: '#4aba6a', margin: 0 },
  emptyDescription: {
    fontSize: 13,
    color: 'var(--text-muted)',
    lineHeight: 1.6,
    margin: '6px 0 0',
  },
  emptyPath: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  emptyCta: {
    marginTop: 14,
    padding: '8px 18px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  inputContainer: {
    padding: '10px 16px 12px',
    borderTop: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    flexShrink: 0,
  },
  imageRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  imagePreview: {
    position: 'relative',
    width: 56,
    height: 56,
    borderRadius: 6,
    overflow: 'hidden',
    border: '1px solid var(--border-light)',
  },
  imageThumb: { width: '100%', height: '100%', objectFit: 'cover' },
  imageRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    background: 'var(--danger)',
    color: '#fff',
    border: 'none',
    borderRadius: '50%',
    cursor: 'pointer',
    fontSize: 11,
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputRow: { display: 'flex', gap: 8, alignItems: 'flex-end' },
  textarea: {
    flex: 1,
    padding: '10px 12px',
    fontSize: 13,
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--text-primary)',
    resize: 'none',
    maxHeight: 160,
    minHeight: 40,
    fontFamily: 'inherit',
    outline: 'none',
  },
  sendBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(26, 122, 60, 0.18)',
    border: '1px solid var(--border-glow)',
    color: '#4aba6a',
    cursor: 'pointer',
    flexShrink: 0,
  },
  abortBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: 'var(--radius-sm)',
    background: 'var(--danger)',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
  },
  abortSquare: { display: 'block', width: 11, height: 11, background: '#fff', borderRadius: 2 },
  progressTrack: {
    height: 2,
    borderRadius: 2,
    overflow: 'hidden',
    background: 'rgba(255,255,255,0.05)',
  },
  progressBar: {
    height: '100%',
    width: '35%',
    background: 'linear-gradient(90deg, transparent, #4aba6a, transparent)',
  },
  bottomBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bottomBarLeft: { display: 'flex', alignItems: 'center', gap: 2 },
  bottomBarRight: { display: 'flex', alignItems: 'center', gap: 8 },
  picker: {
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: 'none',
    borderRadius: 4,
    padding: '2px 4px',
    fontSize: 11,
    cursor: 'pointer',
    outline: 'none',
    maxWidth: 200,
  },
  pickerDivider: { fontSize: 11, color: 'var(--text-muted)' },
};
