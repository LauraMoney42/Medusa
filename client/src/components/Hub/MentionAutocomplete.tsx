import { useEffect, useRef, useState, useCallback } from 'react';
import type React from 'react';
import { useSessionStore } from '../../stores/sessionStore';

interface MentionAutocompleteProps {
  /** Current textarea input value */
  inputValue: string;
  /** Cursor position in the textarea */
  cursorPosition: number;
  /** Called when user selects a mention — provides full new input value and new cursor pos */
  onSelect: (newValue: string, newCursorPos: number) => void;
  /** Called to dismiss the popup */
  onDismiss: () => void;
  /** Whether the popup is visible */
  visible: boolean;
}

/**
 * @-mention autocomplete dropdown for Hub chat.
 * Shows filtered bot suggestions when user types @ followed by characters.
 * Tab or Enter to complete, Escape to dismiss.
 */
export default function MentionAutocomplete({
  inputValue,
  cursorPosition,
  onSelect,
  onDismiss: _onDismiss,
  visible,
}: MentionAutocompleteProps) {
  // _onDismiss is handled by the parent (HubFeed) via keyboard events
  void _onDismiss;
  const sessions = useSessionStore((s) => s.sessions);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Build mention candidates: all bot names + "You" + "all"
  const candidates = [
    ...sessions.map((s) => s.name),
    'You',
    'all',
  ];

  // Extract the @query from the current cursor position
  const mentionQuery = getMentionQuery(inputValue, cursorPosition);

  // Filter candidates by query
  const filtered = mentionQuery !== null
    ? candidates.filter((name) =>
        name.toLowerCase().startsWith(mentionQuery.toLowerCase())
      )
    : [];

  // Reset selection when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length, mentionQuery]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.children;
    if (items[selectedIndex]) {
      (items[selectedIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleSelect = useCallback((name: string) => {
    if (mentionQuery === null) return;
    const atStart = cursorPosition - mentionQuery.length - 1; // -1 for the @
    const before = inputValue.slice(0, atStart);
    const after = inputValue.slice(cursorPosition);
    const newValue = `${before}@${name} ${after}`;
    const newCursor = before.length + name.length + 2; // +2 for @ and trailing space
    onSelect(newValue, newCursor);
  }, [inputValue, cursorPosition, mentionQuery, onSelect]);

  if (!visible || filtered.length === 0 || mentionQuery === null) {
    return null;
  }

  return (
    <div style={styles.container} ref={listRef}>
      {filtered.map((name, i) => (
        <div
          key={name}
          style={{
            ...styles.item,
            ...(i === selectedIndex ? styles.itemSelected : {}),
          }}
          onMouseDown={(e) => {
            e.preventDefault(); // Don't blur textarea
            handleSelect(name);
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span style={styles.at}>@</span>
          <span style={styles.name}>{name}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Extract the mention query from input at cursor position.
 * Returns the text after @ if currently typing a mention, or null.
 * e.g. "hello @De|v" with cursor at | → "De"
 */
function getMentionQuery(input: string, cursor: number): string | null {
  // Walk backward from cursor to find @
  const before = input.slice(0, cursor);
  const atIndex = before.lastIndexOf('@');
  if (atIndex === -1) return null;

  // @ must be at start of input or preceded by whitespace
  if (atIndex > 0 && !/\s/.test(before[atIndex - 1])) return null;

  const query = before.slice(atIndex + 1);

  // No spaces in query (single word/name being typed)
  // Allow spaces in bot names like "Full Stack Dev" — up to 3 words
  const words = query.split(/\s+/);
  if (words.length > 4) return null;

  // Don't trigger on completed mentions (query followed by space at cursor)
  if (cursor < input.length && input[cursor] === ' ' && query.length > 0) return null;

  return query;
}

/**
 * Handle keyboard events for the autocomplete.
 * Call this from the parent textarea's onKeyDown.
 * Returns true if the event was consumed.
 */
export function handleMentionKeyDown(
  e: React.KeyboardEvent,
  filtered: string[],
  selectedIndex: number,
  setSelectedIndex: (i: number) => void,
  onSelect: (name: string) => void,
  onDismiss: () => void,
): boolean {
  if (filtered.length === 0) return false;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setSelectedIndex((selectedIndex + 1) % filtered.length);
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    setSelectedIndex((selectedIndex - 1 + filtered.length) % filtered.length);
    return true;
  }
  if (e.key === 'Tab' || (e.key === 'Enter' && filtered.length > 0)) {
    e.preventDefault();
    onSelect(filtered[selectedIndex]);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    onDismiss();
    return true;
  }
  return false;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    maxHeight: 200,
    overflowY: 'auto',
    background: '#2a2a2c',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: 'var(--radius-md, 10px)',
    marginBottom: 4,
    boxShadow: '0 -4px 16px rgba(0, 0, 0, 0.3)',
    zIndex: 100,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '8px 12px',
    cursor: 'pointer',
    transition: 'background 0.1s',
  },
  itemSelected: {
    background: 'rgba(74, 186, 106, 0.15)',
  },
  at: {
    color: '#4aba6a',
    fontWeight: 700,
    fontSize: 14,
  },
  name: {
    color: 'var(--text-primary)',
    fontSize: 14,
    fontWeight: 500,
  },
};
