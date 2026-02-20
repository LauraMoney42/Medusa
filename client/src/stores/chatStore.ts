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

  setError: (sessionId, messageId, error) =>
    set((s) => {
      const list = s.messages[sessionId];
      if (!list) return s;
      return {
        streamingMessageId: null,
        messages: {
          ...s.messages,
          [sessionId]: list.map((m) =>
            m.id === messageId
              ? { ...m, isStreaming: false, text: m.text + `\n\n**Error:** ${error}` }
              : m,
          ),
        },
      };
    }),
}));
