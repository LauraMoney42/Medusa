import { create } from 'zustand';
import type { ChatMessage, ToolUse } from '../types/message';
import * as api from '../api';

interface ChatState {
  /** sessionId -> ordered messages */
  messages: Record<string, ChatMessage[]>;
  streamingMessageId: string | null;
  /** Track which sessions have had history loaded */
  loadedSessions: Record<string, boolean>;
}

interface ChatActions {
  loadMessages: (sessionId: string) => Promise<void>;
  addUserMessage: (msg: ChatMessage) => void;
  startStreaming: (msg: ChatMessage) => void;
  appendDelta: (sessionId: string, messageId: string, delta: string) => void;
  addToolUse: (sessionId: string, messageId: string, tool: ToolUse) => void;
  setToolResult: (
    sessionId: string,
    messageId: string,
    result: { toolUseId?: string; output: string; isError?: boolean },
  ) => void;
  finishStreaming: (
    sessionId: string,
    messageId: string,
    extras?: { cost?: number; durationMs?: number },
  ) => void;
  setError: (sessionId: string, messageId: string, error: string) => void;
}

export const useChatStore = create<ChatState & ChatActions>((set, get) => ({
  messages: {},
  streamingMessageId: null,
  loadedSessions: {},

  loadMessages: async (sessionId) => {
    const state = get();
    // Skip if already loaded (avoid re-fetching on every click)
    if (state.loadedSessions[sessionId]) return;
    try {
      const messages = await api.fetchMessages(sessionId);
      set((s) => ({
        messages: { ...s.messages, [sessionId]: messages },
        loadedSessions: { ...s.loadedSessions, [sessionId]: true },
      }));
    } catch {
      // If fetch fails, mark as loaded so we don't keep retrying
      set((s) => ({
        loadedSessions: { ...s.loadedSessions, [sessionId]: true },
      }));
    }
  },

  addUserMessage: (msg) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [msg.sessionId]: [...(s.messages[msg.sessionId] ?? []), msg],
      },
    })),

  startStreaming: (msg) =>
    set((s) => ({
      streamingMessageId: msg.id,
      messages: {
        ...s.messages,
        [msg.sessionId]: [
          ...(s.messages[msg.sessionId] ?? []),
          { ...msg, isStreaming: true },
        ],
      },
    })),

  appendDelta: (sessionId, messageId, delta) =>
    set((s) => {
      const list = s.messages[sessionId];
      if (!list) return s;
      return {
        messages: {
          ...s.messages,
          [sessionId]: list.map((m) =>
            m.id === messageId ? { ...m, text: m.text + delta } : m,
          ),
        },
      };
    }),

  addToolUse: (sessionId, messageId, tool) =>
    set((s) => {
      const list = s.messages[sessionId];
      if (!list) return s;
      return {
        messages: {
          ...s.messages,
          [sessionId]: list.map((m) =>
            m.id === messageId
              ? { ...m, toolUses: [...(m.toolUses ?? []), tool] }
              : m,
          ),
        },
      };
    }),

  /**
   * Attach a tool's output to the card that made the call. Pairs by tool id so
   * parallel and subagent calls land on the right card; falls back to the most
   * recent card still awaiting output when no id is available.
   */
  setToolResult: (sessionId, messageId, result) =>
    set((s) => {
      const list = s.messages[sessionId];
      if (!list) return s;
      return {
        messages: {
          ...s.messages,
          [sessionId]: list.map((m) => {
            if (m.id !== messageId || !m.toolUses) return m;
            let targetIndex = result.toolUseId
              ? m.toolUses.findIndex((t) => t.id === result.toolUseId)
              : -1;
            if (targetIndex === -1) {
              for (let i = m.toolUses.length - 1; i >= 0; i--) {
                if (m.toolUses[i].output == null) {
                  targetIndex = i;
                  break;
                }
              }
            }
            if (targetIndex === -1) return m;
            return {
              ...m,
              toolUses: m.toolUses.map((t, i) =>
                i === targetIndex
                  ? { ...t, output: result.output, isError: result.isError }
                  : t,
              ),
            };
          }),
        },
      };
    }),

  finishStreaming: (sessionId, messageId, extras) =>
    set((s) => {
      const list = s.messages[sessionId];
      if (!list) return s;
      return {
        streamingMessageId: null,
        messages: {
          ...s.messages,
          [sessionId]: list.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  isStreaming: false,
                  cost: extras?.cost ?? m.cost,
                  durationMs: extras?.durationMs ?? m.durationMs,
                }
              : m,
          ),
        },
      };
    }),

  // Renders the error as a distinct line on the message (message.errors)
  // instead of appending it to the text, so it shows up clearly styled
  // rather than as plain concatenated text. Consecutive-deduped: if the
  // same error string already sits at the end of the list (e.g. tier
  // escalation failing the same way twice), it isn't added again.
  setError: (sessionId, messageId, error) =>
    set((s) => {
      const list = s.messages[sessionId];
      if (!list) return s;
      return {
        streamingMessageId: null,
        messages: {
          ...s.messages,
          [sessionId]: list.map((m) => {
            if (m.id !== messageId) return m;
            const errors = m.errors ?? [];
            const isDuplicate = errors[errors.length - 1] === error;
            return {
              ...m,
              isStreaming: false,
              errors: isDuplicate ? errors : [...errors, error],
            };
          }),
        },
      };
    }),
}));
