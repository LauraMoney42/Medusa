import { create } from 'zustand';
import * as api from '../api';
import type { AllSubagentsRow } from '../api';
import type { Subagent, SubagentStatus } from './subagentStore';

/**
 * The Tasks panel (S15) shows one merged list of everything Medusa is doing
 * in the background, across every chat: subagents (live via subagentStore),
 * queued follow-ups, and the active voice turn. This store owns the two
 * pieces subagentStore does not carry on its own:
 *
 *  - `hydrated`: a snapshot of every chat's subagents fetched once on load
 *    (`GET /api/subagents?all=1`), so a reload still shows what is running
 *    instead of coming up empty until the next socket event repopulates
 *    subagentStore for the CURRENT chat only.
 *  - `followupQueued`: which finished subagents have a follow-up turn
 *    waiting to be delivered, from the `followup:queued` / `followup:delivered`
 *    socket events (useSocket.ts). subagentStore has no concept of this; it
 *    is purely a followups.ts/FollowupService notion.
 *
 * The actual row list is assembled by `buildTaskRows` below rather than
 * stored here, so it always reflects the live subagentStore/voiceStore state
 * instead of a second copy that could drift out of sync.
 */

export interface HydratedTask extends AllSubagentsRow {}

interface TasksState {
  hydrated: Record<string, HydratedTask>;
  hydratedOnce: boolean;
  followupQueued: Record<string, true>;
}

interface TasksActions {
  hydrate: () => Promise<void>;
  markFollowupQueued: (agentId: string) => void;
  clearFollowupQueued: (agentIds: string[]) => void;
}

export const useTasksStore = create<TasksState & TasksActions>((set) => ({
  hydrated: {},
  hydratedOnce: false,
  followupQueued: {},

  hydrate: async () => {
    try {
      const rows = await api.fetchAllSubagents();
      const hydrated: Record<string, HydratedTask> = {};
      for (const row of rows) hydrated[row.agentId] = row;
      set({ hydrated, hydratedOnce: true });
    } catch (err) {
      // A failed hydrate leaves the panel showing only what socket events
      // bring in for the current chat -- degraded, not broken.
      console.warn('[tasksStore] hydrate failed:', err);
      set({ hydratedOnce: true });
    }
  },

  markFollowupQueued: (agentId) =>
    set((s) => ({ followupQueued: { ...s.followupQueued, [agentId]: true } })),

  clearFollowupQueued: (agentIds) =>
    set((s) => {
      const followupQueued = { ...s.followupQueued };
      for (const id of agentIds) delete followupQueued[id];
      return { followupQueued };
    }),
}));

export type TaskKind = 'subagent' | 'followup' | 'voice';

export interface TaskRow {
  /** Unique across the whole list: `${kind}:${agentId-or-sessionId}`. */
  id: string;
  kind: TaskKind;
  status: SubagentStatus | 'active';
  /** Subagent name / follow-up target / "Voice turn". */
  name: string;
  /** What shows under the name: the task text, or a short kind description. */
  detail: string;
  sessionId: string;
  chatTitle: string;
  engine?: string;
  model?: string | null;
  startedAt: string;
  endedAt?: string | null;
  /** Present only for rows that can be stopped (a running/queued subagent). */
  agentId?: string;
  /** DOM id of the SubagentCard to scroll to on click-to-jump, when known. */
  anchorId?: string;
}

const TERMINAL: ReadonlySet<SubagentStatus> = new Set(['done', 'error', 'cancelled']);

function chatTitle(sessions: { id: string; name: string }[], sessionId: string): string {
  return sessions.find((s) => s.id === sessionId)?.name ?? sessionId;
}

/**
 * Merge live subagents with the hydrated snapshot (live wins on conflict:
 * the socket stream is always more current than a page-load fetch), add a
 * synthetic "follow-up queued" row per pending follow-up, and a "Voice turn"
 * row when the loop is not idle.
 */
export function buildTaskRows(args: {
  subagentsById: Record<string, Subagent>;
  hydrated: Record<string, HydratedTask>;
  followupQueued: Record<string, true>;
  sessions: { id: string; name: string }[];
  voiceState: 'idle' | 'listening' | 'thinking' | 'speaking';
  activeSessionId: string | null;
}): TaskRow[] {
  const { subagentsById, hydrated, followupQueued, sessions, voiceState, activeSessionId } = args;
  const rows: TaskRow[] = [];
  const seen = new Set<string>();

  for (const agent of Object.values(subagentsById)) {
    seen.add(agent.id);
    rows.push({
      id: `subagent:${agent.id}`,
      kind: 'subagent',
      status: agent.status,
      name: agent.name,
      detail: agent.task,
      sessionId: agent.parentSessionId,
      chatTitle: chatTitle(sessions, agent.parentSessionId),
      engine: agent.engine,
      model: agent.model,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
      agentId: agent.status === 'running' || agent.status === 'queued' ? agent.id : undefined,
      anchorId: `subagent-card-${agent.id}`,
    });
  }

  for (const row of Object.values(hydrated)) {
    if (seen.has(row.agentId)) continue;
    seen.add(row.agentId);
    rows.push({
      id: `subagent:${row.agentId}`,
      kind: 'subagent',
      status: row.status,
      name: row.name,
      detail: '',
      sessionId: row.parentSessionId,
      chatTitle: chatTitle(sessions, row.parentSessionId),
      engine: row.engine,
      model: row.model,
      startedAt: row.startedAt,
      endedAt: row.endedAt ?? null,
      agentId: row.status === 'running' || row.status === 'queued' ? row.agentId : undefined,
      anchorId: `subagent-card-${row.agentId}`,
    });
  }

  for (const agentId of Object.keys(followupQueued)) {
    const source = subagentsById[agentId] ?? hydrated[agentId];
    if (!source) continue;
    const sessionId = 'parentSessionId' in source ? source.parentSessionId : '';
    rows.push({
      id: `followup:${agentId}`,
      kind: 'followup',
      status: 'active',
      name: `Follow-up: ${source.name}`,
      detail: 'Waiting for the chat to go idle so the result can be delivered.',
      sessionId,
      chatTitle: chatTitle(sessions, sessionId),
      startedAt: source.endedAt ?? source.startedAt,
      anchorId: `subagent-card-${agentId}`,
    });
  }

  if (voiceState !== 'idle' && activeSessionId) {
    rows.push({
      id: `voice:${activeSessionId}`,
      kind: 'voice',
      status: 'active',
      name: 'Voice turn',
      detail: voiceState === 'listening' ? 'Listening' : voiceState === 'thinking' ? 'Thinking' : 'Speaking',
      sessionId: activeSessionId,
      chatTitle: chatTitle(sessions, activeSessionId),
      startedAt: new Date().toISOString(),
    });
  }

  return rows;
}

export function isRunning(row: TaskRow): boolean {
  if (row.kind !== 'subagent') return true;
  return row.status === 'running' || row.status === 'queued';
}

export function isFinished(row: TaskRow): boolean {
  return row.kind === 'subagent' && TERMINAL.has(row.status as SubagentStatus);
}

/**
 * Count of running subagents across every chat, merging live subagentStore
 * data with the hydrated snapshot the same way `buildTaskRows` does. Used by
 * the header badge (ChatHeaderControls.tsx), which needs the count without
 * mounting the panel itself.
 */
export function countRunningSubagents(
  subagentsById: Record<string, Subagent>,
  hydrated: Record<string, HydratedTask>,
): number {
  let count = 0;
  const seen = new Set<string>();
  for (const agent of Object.values(subagentsById)) {
    seen.add(agent.id);
    if (agent.status === 'running' || agent.status === 'queued') count++;
  }
  for (const row of Object.values(hydrated)) {
    if (seen.has(row.agentId)) continue;
    if (row.status === 'running' || row.status === 'queued') count++;
  }
  return count;
}
