import { create } from 'zustand';

/**
 * Live state for every Medusa-managed subagent (spec A.6). Keyed by the
 * server's `sa_...` agent id; `SubagentCard` looks a record up by the parent's
 * `spawn_agent` tool_use block so the card can replace that tool card inline.
 */

export type SubagentStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** One tool call inside a subagent's own stream, paired with its result. */
export interface SubagentTool {
  id?: string;
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}

export interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Subagent {
  id: string;
  parentSessionId: string;
  /** The parent's `spawn_agent` tool_use id, when the server correlated one. */
  parentToolUseId: string | null;
  name: string;
  task: string;
  engine: string;
  model: string | null;
  cwd: string;
  status: SubagentStatus;
  /** ISO-8601; the card's elapsed timer counts from here. */
  startedAt: string;
  endedAt: string | null;
  /** Text streamed from the subagent, replaced by the final result when done. */
  text: string;
  tools: SubagentTool[];
  usage: SubagentUsage;
  durationMs?: number;
  truncated?: boolean;
  error?: string;
}

export interface SubagentStartPayload {
  sessionId: string;
  agentId: string;
  parentToolUseId?: string | null;
  name?: string;
  task?: string;
  engineId?: string;
  model?: string | null;
  cwd?: string;
  startedAt?: string;
}

export interface SubagentDeltaPayload {
  sessionId: string;
  agentId: string;
  delta: string;
}

export interface SubagentToolPayload {
  sessionId: string;
  agentId: string;
  tool?: { id?: string; name?: string; input?: unknown };
  toolResult?: { toolUseId?: string; output?: string; isError?: boolean };
}

export interface SubagentEndPayload {
  sessionId: string;
  agentId: string;
  status?: SubagentStatus;
  resultText?: string;
  truncated?: boolean;
  usage?: Partial<SubagentUsage>;
  durationMs?: number;
  endedAt?: string;
  error?: string;
}

interface SubagentState {
  byId: Record<string, Subagent>;
  /** parent sessionId -> agent ids, in spawn order. */
  bySession: Record<string, string[]>;
}

interface SubagentActions {
  start: (payload: SubagentStartPayload) => void;
  appendDelta: (payload: SubagentDeltaPayload) => void;
  addToolEvent: (payload: SubagentToolPayload) => void;
  end: (payload: SubagentEndPayload) => void;
  clearSession: (sessionId: string) => void;
}

const TERMINAL: SubagentStatus[] = ['done', 'error', 'cancelled'];

export const useSubagentStore = create<SubagentState & SubagentActions>((set) => ({
  byId: {},
  bySession: {},

  start: (payload) =>
    set((s) => {
      const existing = s.byId[payload.agentId];
      const record: Subagent = {
        id: payload.agentId,
        parentSessionId: payload.sessionId,
        parentToolUseId: payload.parentToolUseId ?? null,
        name: payload.name || 'subagent',
        task: payload.task ?? '',
        engine: payload.engineId ?? 'unknown',
        model: payload.model ?? null,
        cwd: payload.cwd ?? '',
        status: 'running',
        startedAt: payload.startedAt ?? new Date().toISOString(),
        endedAt: null,
        // A restart of the same id (queued, then started) keeps whatever text
        // and tool cards already arrived rather than blanking the card.
        text: existing?.text ?? '',
        tools: existing?.tools ?? [],
        usage: existing?.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
      const ids = s.bySession[payload.sessionId] ?? [];
      return {
        byId: { ...s.byId, [payload.agentId]: record },
        bySession: {
          ...s.bySession,
          [payload.sessionId]: ids.includes(payload.agentId)
            ? ids
            : [...ids, payload.agentId],
        },
      };
    }),

  appendDelta: (payload) =>
    set((s) => {
      const record = s.byId[payload.agentId];
      if (!record) return s;
      return {
        byId: {
          ...s.byId,
          [payload.agentId]: { ...record, text: record.text + payload.delta },
        },
      };
    }),

  addToolEvent: (payload) =>
    set((s) => {
      const record = s.byId[payload.agentId];
      if (!record) return s;

      if (payload.tool) {
        const tool: SubagentTool = {
          id: payload.tool.id,
          name: payload.tool.name ?? 'tool',
          input: payload.tool.input,
        };
        return {
          byId: {
            ...s.byId,
            [payload.agentId]: { ...record, tools: [...record.tools, tool] },
          },
        };
      }

      if (payload.toolResult) {
        // Pair by id, not by arrival order: a subagent can run tools in
        // parallel, so the last card is not necessarily the right one.
        const id = payload.toolResult.toolUseId;
        let index = id ? record.tools.findIndex((t) => t.id === id) : -1;
        if (index === -1) index = record.tools.length - 1;
        if (index < 0) return s;
        const tools = record.tools.slice();
        tools[index] = {
          ...tools[index]!,
          output: payload.toolResult.output,
          isError: payload.toolResult.isError,
        };
        return { byId: { ...s.byId, [payload.agentId]: { ...record, tools } } };
      }

      return s;
    }),

  end: (payload) =>
    set((s) => {
      const record = s.byId[payload.agentId];
      if (!record) return s;
      const status = payload.status ?? 'done';
      return {
        byId: {
          ...s.byId,
          [payload.agentId]: {
            ...record,
            status: TERMINAL.includes(status) ? status : 'done',
            endedAt: payload.endedAt ?? new Date().toISOString(),
            // The final result text is authoritative; fall back to whatever
            // was streamed when the engine sent no result payload.
            text: payload.resultText ? payload.resultText : record.text,
            truncated: payload.truncated,
            durationMs: payload.durationMs,
            error: payload.error,
            usage: {
              inputTokens: payload.usage?.inputTokens ?? record.usage.inputTokens,
              outputTokens: payload.usage?.outputTokens ?? record.usage.outputTokens,
              costUsd: payload.usage?.costUsd ?? record.usage.costUsd,
            },
          },
        },
      };
    }),

  clearSession: (sessionId) =>
    set((s) => {
      const ids = s.bySession[sessionId];
      if (!ids) return s;
      const byId = { ...s.byId };
      for (const id of ids) delete byId[id];
      const bySession = { ...s.bySession };
      delete bySession[sessionId];
      return { byId, bySession };
    }),
}));

/**
 * Find the subagent a `spawn_agent` tool_use block belongs to. Exact
 * `parentToolUseId` first (the server correlates the two in
 * `SubagentManager.registerSpawnToolUse`), then the oldest subagent in this
 * chat that has no anchor yet, which is the same FIFO rule the server uses
 * when the shim call lands before the tool_use block does.
 */
export function findSubagentForToolUse(
  state: SubagentState,
  sessionId: string,
  toolUseId: string | undefined,
): Subagent | undefined {
  const ids = state.bySession[sessionId];
  if (!ids || ids.length === 0) return undefined;
  const records = ids.map((id) => state.byId[id]).filter(Boolean) as Subagent[];
  if (toolUseId) {
    const exact = records.find((r) => r.parentToolUseId === toolUseId);
    if (exact) return exact;
  }
  return records.find((r) => r.parentToolUseId == null);
}
