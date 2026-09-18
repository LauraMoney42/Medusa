import { create } from 'zustand';

/**
 * The Activity Log's data path: the full raw stream for a chat, kept in a
 * bounded ring so a long-running session cannot grow the tab's memory without
 * limit. The server builds every line (server/src/socket/activity.ts); this
 * store only buffers them per session.
 */

export type ActivityKind =
  | 'init'
  | 'text'
  | 'thinking'
  | 'tool'
  | 'tool_input'
  | 'tool_result'
  | 'assistant'
  | 'result'
  | 'error'
  | 'subagent_start'
  | 'subagent_text'
  | 'subagent_tool'
  | 'subagent_tool_result'
  | 'subagent_end';

export interface ActivityTokens {
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  costUsd?: number;
}

export interface ActivityEvent {
  sessionId: string;
  ts: string;
  kind: ActivityKind;
  summary: string;
  detail?: string;
  /** True when the server clipped `detail` at its 8k cap. */
  detailTruncated?: boolean;
  tokens?: ActivityTokens;
  subagentId?: string;
  parentToolUseId?: string | null;
}

/** A line carries a client-side id so React keys stay stable in the ring. */
export interface ActivityEntry extends ActivityEvent {
  id: number;
}

/** Per-session ring capacity. Oldest lines fall off the front. */
export const ACTIVITY_RING_SIZE = 5000;

interface ActivityState {
  bySession: Record<string, ActivityEntry[]>;
}

interface ActivityActions {
  push: (event: ActivityEvent) => void;
  clear: (sessionId: string) => void;
  clearAll: () => void;
}

let nextId = 1;

export const useActivityStore = create<ActivityState & ActivityActions>((set) => ({
  bySession: {},

  push: (event) =>
    set((s) => {
      if (!event?.sessionId) return s;
      const existing = s.bySession[event.sessionId] ?? [];
      const entry: ActivityEntry = { ...event, id: nextId++ };
      const next =
        existing.length >= ACTIVITY_RING_SIZE
          ? [...existing.slice(existing.length - ACTIVITY_RING_SIZE + 1), entry]
          : [...existing, entry];
      return { bySession: { ...s.bySession, [event.sessionId]: next } };
    }),

  clear: (sessionId) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: [] } })),

  clearAll: () => set({ bySession: {} }),
}));
