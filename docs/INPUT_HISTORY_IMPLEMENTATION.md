# Input History (Up/Down Arrow) — Implementation Guide

Bash-style input history for textarea inputs. Users press **Up Arrow** to recall previously sent messages, **Down Arrow** to move forward through history, exactly like a terminal.

## How It Works

```
User sends: "hello"
User sends: "run tests"
User sends: "deploy to staging"

[textarea is empty, cursor at position 0]

  Up Arrow  → "deploy to staging"
  Up Arrow  → "run tests"
  Up Arrow  → "hello"
  Down Arrow → "run tests"
  Down Arrow → "deploy to staging"
  Down Arrow → ""  (restores whatever was in the textarea before navigating)
```

Key behaviors:
- **Up Arrow** only activates when cursor is at position 0 (start of text)
- **Down Arrow** only activates when cursor is at the end of the text
- If the user had unsent text in the textarea when they first pressed Up, it's stashed and restored when they arrow past the newest entry
- Typing anything resets navigation back to the "not navigating" state
- History persists across sessions via `localStorage`
- History is scoped per input context (e.g. per chat session, or a shared "hub" scope)
- Capped at 50 entries per scope; consecutive duplicate messages are skipped

---

## Architecture

Three touch points:

| Component | Role |
|-----------|------|
| **`inputHistoryStore.ts`** | Zustand store — manages history arrays, navigation index, and stash. Persists to localStorage. |
| **Send handler** | On message send: push the sent text into the store, reset navigation. |
| **KeyDown handler** | On ArrowUp/ArrowDown: call `up()`/`down()` from the store, update the textarea value. |

---

## Step 1: Create the Input History Store

This is a standalone Zustand store with `persist` middleware. It has two layers of state:

- **Persisted** (`history`): the actual message arrays, keyed by scope string
- **Transient** (`_index`, `_stash`): navigation cursor and stashed text — not saved to localStorage

### Full code: `inputHistoryStore.ts`

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MAX_HISTORY = 50;

interface InputHistoryState {
  /** Persisted: sent messages per scope (newest last). Scope is "hub" or a sessionId. */
  history: Record<string, string[]>;

  // Transient navigation state (not persisted)
  _index: Record<string, number>;   // -1 = not navigating
  _stash: Record<string, string>;   // unsent text saved on first Up press

  push: (scope: string, text: string) => void;
  up: (scope: string, currentText: string) => string | null;
  down: (scope: string) => string | null;
  resetNav: (scope: string) => void;
}

export const useInputHistoryStore = create<InputHistoryState>()(
  persist(
    (set, get) => ({
      history: {},
      _index: {},
      _stash: {},

      push: (scope, text) =>
        set((state) => {
          const prev = state.history[scope] ?? [];
          // Skip consecutive duplicates
          if (prev.length > 0 && prev[prev.length - 1] === text) {
            return state;
          }
          const next = [...prev, text].slice(-MAX_HISTORY);
          return {
            history: { ...state.history, [scope]: next },
            // Reset navigation on push
            _index: { ...state._index, [scope]: -1 },
            _stash: { ...state._stash, [scope]: '' },
          };
        }),

      up: (scope, currentText) => {
        const state = get();
        const entries = state.history[scope];
        if (!entries || entries.length === 0) return null;

        let idx = state._index[scope] ?? -1;

        // First press: stash current text and start at end of history
        if (idx === -1) {
          idx = entries.length - 1;
          set({
            _index: { ...state._index, [scope]: idx },
            _stash: { ...state._stash, [scope]: currentText },
          });
          return entries[idx];
        }

        // Already navigating: move back if possible
        if (idx > 0) {
          idx -= 1;
          set({ _index: { ...state._index, [scope]: idx } });
          return entries[idx];
        }

        // At oldest entry, don't wrap
        return null;
      },

      down: (scope) => {
        const state = get();
        const entries = state.history[scope];
        if (!entries || entries.length === 0) return null;

        const idx = state._index[scope] ?? -1;
        if (idx === -1) return null; // Not navigating

        if (idx < entries.length - 1) {
          // Move forward in history
          const newIdx = idx + 1;
          set({ _index: { ...state._index, [scope]: newIdx } });
          return entries[newIdx];
        }

        // Past the newest entry: restore stashed text and exit nav
        set({
          _index: { ...state._index, [scope]: -1 },
        });
        return state._stash[scope] ?? '';
      },

      resetNav: (scope) => {
        const state = get();
        if ((state._index[scope] ?? -1) === -1) return; // already reset
        set({
          _index: { ...state._index, [scope]: -1 },
          _stash: { ...state._stash, [scope]: '' },
        });
      },
    }),
    {
      name: 'medusa-input-history',  // localStorage key — change for your app
      partialize: (state) => ({ history: state.history }),
    }
  )
);
```

### Store API Reference

| Method | Signature | Description |
|--------|-----------|-------------|
| `push` | `(scope: string, text: string) => void` | Add a sent message to history. Call after successful send. Deduplicates consecutive identical messages. Caps at 50 entries. |
| `up` | `(scope: string, currentText: string) => string \| null` | Navigate backward. On first call, stashes `currentText` and returns the most recent history entry. Subsequent calls move further back. Returns `null` when at the oldest entry. |
| `down` | `(scope: string) => string \| null` | Navigate forward. Returns the next history entry, or the stashed text when moving past the newest entry. Returns `null` when not navigating. |
| `resetNav` | `(scope: string) => void` | Exit navigation mode. Call when the user types manually (onChange). |

The `scope` parameter is a string key that isolates history per input context. Use a session ID for per-session inputs, or a constant like `"hub"` for a shared input.

---

## Step 2: Wire Up the Send Handler

After a successful message send, push the text and reset navigation.

```typescript
// Inside your component:
const historyPush = useInputHistoryStore((s) => s.push);
const historyReset = useInputHistoryStore((s) => s.resetNav);

// In your send function, after emitting the message:
const send = async () => {
  const trimmed = text.trim();
  if (!trimmed) return;

  // ... your send logic (socket emit, API call, etc.) ...

  historyPush(scope, trimmed);   // Add to history
  historyReset(scope);           // Reset nav state
  setText('');                    // Clear input
};
```

---

## Step 3: Wire Up the KeyDown Handler

This is the core UX integration. The key subtlety is **cursor position gating** — Up Arrow only fires when the cursor is at position 0, Down Arrow only when at the end. This prevents history navigation from interfering with normal multiline text editing.

The second subtlety is **cursor repositioning via `requestAnimationFrame`** — after React re-renders the textarea with the recalled text, the cursor lands at the end. Without repositioning, the next Up press would fail the `selectionStart === 0` check and the user would have to press Up twice.

```typescript
const historyUp = useInputHistoryStore((s) => s.up);
const historyDown = useInputHistoryStore((s) => s.down);

const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
  // ── Arrow Up: recall previous message ──
  if (e.key === 'ArrowUp' && !e.shiftKey) {
    const el = e.currentTarget;
    if (el.selectionStart === 0 && el.selectionEnd === 0) {
      const prev = historyUp(scope, text);
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

  // ── Arrow Down: recall next message or restore stash ──
  if (e.key === 'ArrowDown' && !e.shiftKey) {
    const el = e.currentTarget;
    if (el.selectionStart === el.value.length) {
      const next = historyDown(scope);
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

  // ── Enter to send ──
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
};
```

---

## Step 4: Reset on Manual Typing

When the user types anything (not via history navigation), reset the navigation index so the next Up press starts from the most recent entry again.

```typescript
const historyReset = useInputHistoryStore((s) => s.resetNav);

// In your onChange handler:
<textarea
  onChange={(e) => {
    setText(e.target.value);
    historyReset(scope);    // ← exit history navigation on manual typing
  }}
  onKeyDown={handleKeyDown}
/>
```

**Important:** `setText()` (React state update) does NOT trigger `onChange` — only user-initiated input events do. So calling `setText(prev)` from the ArrowUp handler will NOT accidentally reset navigation.

---

## Gotchas & Lessons Learned

### 1. Cursor position after `setText()` (the main bug we hit)

When you call `setText(recalledMessage)`, React re-renders the textarea and the browser places the cursor at the **end** of the text. On the next Up press, `selectionStart` will be at the end, not 0, so the guard condition fails.

**Fix:** Use `requestAnimationFrame` to reposition the cursor after React's render cycle:
```typescript
requestAnimationFrame(() => {
  el.selectionStart = 0;
  el.selectionEnd = 0;
});
```

### 2. Autocomplete / dropdown conflicts

If your textarea has an autocomplete dropdown (like @-mentions) that also uses ArrowUp/ArrowDown, make sure the autocomplete handler runs **first** and returns early when visible. History navigation should only kick in when no dropdown is active:

```typescript
const handleKeyDown = (e) => {
  // Autocomplete takes priority when visible
  if (autocompleteVisible) {
    if (e.key === 'ArrowUp') { /* handle autocomplete */ return; }
    if (e.key === 'ArrowDown') { /* handle autocomplete */ return; }
  }

  // History navigation only runs when autocomplete is closed
  if (e.key === 'ArrowUp' && !e.shiftKey) {
    // ... history logic ...
  }
};
```

### 3. `partialize` is critical for the persist middleware

Only persist the `history` record. The `_index` and `_stash` fields are transient navigation state — persisting them would cause confusing behavior on page reload (user would be mid-navigation into a stale position).

```typescript
persist(
  (set, get) => ({ /* ... */ }),
  {
    name: 'your-app-input-history',
    partialize: (state) => ({ history: state.history }),  // ← only persist history
  }
)
```

### 4. Desktop apps (WKWebView / Electron)

If your app wraps the web client in a native shell, make sure the **built assets are deployed** to wherever the native app serves them from. In our case, building the client (`npm run build`) outputs to `client/dist/`, but the desktop app serves from `server/dist/public/`. We needed to run the full build script that copies client assets into the server's public directory.

### 5. History only records messages sent after deployment

Existing messages sent before this feature is deployed won't appear in history. The store starts empty and only populates as users send new messages.

---

## Dependencies

- **[Zustand](https://github.com/pmndrs/zustand)** (v4 or v5) with `persist` middleware
- React 18+ (for controlled textarea + `requestAnimationFrame` cursor fix)
- Any textarea-based input (works with `<textarea>`, not `<input>` — single-line inputs don't have the cursor-position subtlety)

---

## localStorage Schema

Key: `medusa-input-history` (or whatever you set in the persist config)

```json
{
  "state": {
    "history": {
      "hub": ["hello", "run tests", "deploy to staging"],
      "session-abc-123": ["fix the bug", "add tests"],
      "session-def-456": ["update readme"]
    }
  },
  "version": 0
}
```

Each scope key maps to an array of strings (newest last), capped at 50 entries.
