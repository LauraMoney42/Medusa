import type { ChatMessage } from '../../types/message';
import { useChatStore } from '../../stores/chatStore';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import MessageBubble from './MessageBubble';
import JumpToStartButton from './JumpToStartButton';

const EMPTY_MESSAGES: ChatMessage[] = [];

// Hub system messages are routing/polling infrastructure — not part of the human conversation.
// Filter them out of the chat view so bots' individual threads stay clean.
function isHubSystemMessage(msg: ChatMessage): boolean {
  const t = msg.text.trimStart();
  return (
    t.startsWith('[Hub Request]') ||
    t.startsWith('[Hub Check]') ||
    t === '[NO-ACTION]'
  );
}

interface MessageListProps {
  sessionId: string;
  botName?: string;
}

export default function MessageList({ sessionId, botName }: MessageListProps) {
  const allMessages = useChatStore((s) => s.messages[sessionId] ?? EMPTY_MESSAGES);
  // Strip Hub system messages (requests, checks, no-action replies) from the visible thread
  const messages = allMessages.filter((msg) => !isHubSystemMessage(msg));
  const streamingMessageId = useChatStore((s) => s.streamingMessageId);

  // The dependency changes on every delta so auto-scroll stays current
  const lastMsg = messages[messages.length - 1];
  const scrollDep = lastMsg
    ? `${lastMsg.id}-${lastMsg.text.length}-${lastMsg.toolUses?.length ?? 0}`
    : '';

  const { containerRef, isAtBottom, scrollToBottom } =
    useAutoScroll(scrollDep);

  const handleJumpToStart = () => {
    if (!streamingMessageId || !containerRef.current) return;
    // Find the streaming message element and scroll to it
    const el = containerRef.current.querySelector(
      `[data-message-id="${streamingMessageId}"]`,
    );
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div style={styles.wrapper}>
      <div ref={containerRef} style={styles.container}>
        {messages.length === 0 && (
          <div style={styles.emptyHint}>
            <p style={styles.emptyText}>
              Send a message to start the conversation
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} botName={botName} />
        ))}

        {/* Bottom spacer */}
        <div style={{ height: 16 }} />
      </div>

      {!isAtBottom && streamingMessageId && (
        <JumpToStartButton onClick={handleJumpToStart} />
      )}

      {!isAtBottom && !streamingMessageId && (
        <button onClick={scrollToBottom} style={styles.scrollBtn}>
          &#8595; New messages
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
  container: {
    height: '100%',
    overflowY: 'auto',
    padding: '16px 0',
  },
  emptyHint: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  emptyText: {
    color: 'var(--text-muted)',
    fontSize: 14,
  },
  scrollBtn: {
    position: 'absolute',
    bottom: 8,
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '6px 16px',
    background: '#2c2c2e',
    color: 'var(--text-primary)',
    borderRadius: 20,
    fontSize: 13,
    border: '1px solid rgba(255, 255, 255, 0.10)',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.35)',
    cursor: 'pointer',
    zIndex: 10,
  } as React.CSSProperties,
};
