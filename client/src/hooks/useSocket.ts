import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket, disconnectSocket } from '../socket';
import { useChatStore } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSubagentStore } from '../stores/subagentStore';
import { useTasksStore } from '../stores/tasksStore';
import type {
  SubagentStartPayload,
  SubagentDeltaPayload,
  SubagentToolPayload,
  SubagentEndPayload,
} from '../stores/subagentStore';
import { useActivityStore, type ActivityEvent } from '../stores/activityStore';
import { useVoiceStore } from '../stores/voiceStore';
import { emitAudioChunk, emitStopAudio } from '../lib/voice/voiceBus';
import type { ChatMessage, ToolUse } from '../types/message';
import type {
  VoiceStatePayload,
  VoicePartialPayload,
  VoiceTranscriptPayload,
  VoiceAudioChunkPayload,
  VoiceStopAudioPayload,
  VoiceLatencyPayload,
  FollowupQueuedPayload,
  FollowupDeliveredPayload,
} from '../types/voice';

/**
 * Manages the Socket.IO lifecycle and dispatches incoming events
 * to the zustand stores.
 */
export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const startStreaming = useChatStore((s) => s.startStreaming);
  const appendDelta = useChatStore((s) => s.appendDelta);
  const addToolUse = useChatStore((s) => s.addToolUse);
  const setToolResult = useChatStore((s) => s.setToolResult);
  const finishStreaming = useChatStore((s) => s.finishStreaming);
  const setError = useChatStore((s) => s.setError);
  const setSessionStatus = useSessionStore((s) => s.setSessionStatus);
  const setSessionYolo = useSessionStore((s) => s.setSessionYolo);
  const setSessionSystemPrompt = useSessionStore((s) => s.setSessionSystemPrompt);
  const setSessionSkills = useSessionStore((s) => s.setSessionSkills);
  const setSessionWorkingDir = useSessionStore((s) => s.setSessionWorkingDir);
  const subagentStart = useSubagentStore((s) => s.start);
  const subagentDelta = useSubagentStore((s) => s.appendDelta);
  const subagentTool = useSubagentStore((s) => s.addToolEvent);
  const subagentEnd = useSubagentStore((s) => s.end);
  const markFollowupQueued = useTasksStore((s) => s.markFollowupQueued);
  const clearFollowupQueued = useTasksStore((s) => s.clearFollowupQueued);
  const pushActivity = useActivityStore((s) => s.push);
  const setServerShuttingDown = useSessionStore((s) => s.setServerShuttingDown);
  const setVoiceLoopState = useVoiceStore((s) => s.setState);
  const setVoicePartial = useVoiceStore((s) => s.setPartialTranscript);
  const setVoiceLatency = useVoiceStore((s) => s.setLastLatency);
  // Subscribe to sessions so we can join rooms after fetchSessions() resolves
  const sessions = useSessionStore((s) => s.sessions);

  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;

    // Define all handlers as named functions so we can remove them in cleanup
    const handleConnect = () => {
      setConnected(true);
      // Re-join all session rooms and reset any stuck 'busy' status on reconnect
      // (e.g. after server restart, orphaned processes leave client stuck)
      const statuses = useSessionStore.getState().statuses;
      const sessions = useSessionStore.getState().sessions;
      for (const s of sessions) {
        socket.emit('session:join', { sessionId: s.id });
        if (statuses[s.id] === 'busy') {
          setSessionStatus(s.id, 'idle');
        }
      }
    };

    const handleDisconnect = (reason: string) => {
      setConnected(false);
      console.log('[socket] disconnected:', reason);
    };

    const handleOffline = () => {
      setConnected(false);
      console.log('[socket] browser offline');
    };

    // Detect wake-from-sleep and force reconnect if needed
    const handleOnline = () => {
      console.log('[socket] browser online, checking connection');
      if (!socket.connected) {
        socket.connect();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('[socket] tab visible, checking connection');
        if (!socket.connected) {
          socket.connect();
        }
      }
    };

    const handlePageShow = (e: PageTransitionEvent) => {
      // persisted=true means page was restored from bfcache after sleep
      if (e.persisted || !socket.connected) {
        console.log('[socket] pageshow (persisted=', e.persisted, '), reconnecting');
        socket.connect();
      }
    };

    const handleUserMessage = (msg: ChatMessage) => {
      addUserMessage(msg);
    };

    const handleStreamStart = (msg: ChatMessage) => {
      startStreaming(msg);
      setSessionStatus(msg.sessionId, 'busy');
    };

    const handleStreamDelta = (data: { sessionId: string; messageId: string; delta: string }) => {
      appendDelta(data.sessionId, data.messageId, data.delta);
    };

    const handleStreamTool = (data: { sessionId: string; messageId: string; tool: ToolUse }) => {
      addToolUse(data.sessionId, data.messageId, data.tool);
    };

    const handleStreamToolResult = (data: {
      sessionId: string;
      messageId: string;
      toolUseId?: string;
      toolName?: string;
      output: string;
      isError?: boolean;
    }) => {
      setToolResult(data.sessionId, data.messageId, {
        toolUseId: data.toolUseId,
        output: data.output,
        isError: data.isError,
      });
    };

    const handleStreamEnd = (data: {
      sessionId: string;
      messageId: string;
      cost?: number;
      durationMs?: number;
    }) => {
      finishStreaming(data.sessionId, data.messageId, {
        cost: data.cost,
        durationMs: data.durationMs,
      });
      setSessionStatus(data.sessionId, 'idle');
    };

    const handleMessageError = (data: { sessionId: string; messageId: string; error: string }) => {
      setError(data.sessionId, data.messageId, data.error);
      setSessionStatus(data.sessionId, 'idle');
    };

    const handleSessionStatus = (data: { sessionId: string; status: 'idle' | 'busy' }) => {
      setSessionStatus(data.sessionId, data.status);
    };

    const handleYoloChanged = (data: { sessionId: string; yoloMode: boolean }) => {
      setSessionYolo(data.sessionId, data.yoloMode);
    };

    const handleSystemPromptChanged = (data: { sessionId: string; systemPrompt: string }) => {
      setSessionSystemPrompt(data.sessionId, data.systemPrompt);
    };

    const handleSkillsChanged = (data: { sessionId: string; skills: string[] }) => {
      setSessionSkills(data.sessionId, data.skills);
    };

    const handleWorkingDirChanged = (data: { sessionId: string; workingDir: string }) => {
      setSessionWorkingDir(data.sessionId, data.workingDir);
    };

    // ---- Subagents (spec A.6) ----
    const handleSubagentStart = (data: SubagentStartPayload) => {
      subagentStart(data);
    };

    const handleSubagentDelta = (data: SubagentDeltaPayload) => {
      subagentDelta(data);
    };

    const handleSubagentTool = (data: SubagentToolPayload) => {
      subagentTool(data);
    };

    const handleSubagentEnd = (data: SubagentEndPayload) => {
      subagentEnd(data);
    };

    // ---- Activity Log ----
    const handleActivityEvent = (data: ActivityEvent) => {
      pushActivity(data);
    };

    const handleServerShuttingDown = (data: { busySessions: { id: string; name: string }[] }) => {
      console.log('[socket] Server shutting down, waiting for:', data.busySessions);
      setServerShuttingDown(data.busySessions);
    };

    const handleConnectError = (error: Error) => {
      console.log('[socket] connect_error:', error.message);
      // If auth failed, stop the reconnection spiral before we hit the
      // 5-attempt rate limit and force the user back to login.
      if (error.message === 'Authentication failed') {
        socket.disconnect();
        // Notify App.tsx to show the login screen
        window.dispatchEvent(new CustomEvent('medusa:auth-failed'));
      }
    };

    // ---- Voice loop (S14, spec section 7) ----
    // `voice:state` maps the server's 5-state machine onto the client's
    // 4-state UI (spec section 3 vs section 4): "transcribing" collapses
    // into "listening" since the VoiceBar's mic indicator covers both: the
    // user is still mid-utterance from their point of view.
    const handleVoiceState = (data: VoiceStatePayload) => {
      const uiState = data.state === 'transcribing' ? 'listening' : data.state;
      setVoiceLoopState(uiState);
    };

    const handleVoicePartial = (data: VoicePartialPayload) => {
      setVoicePartial(data.text);
    };

    // Final transcripts arrive as a normal `message:user` event (handled
    // above) so chat history stays complete; this event just means the
    // partial is now stale.
    const handleVoiceTranscript = (_data: VoiceTranscriptPayload) => {
      setVoicePartial('');
    };

    const handleVoiceAudioChunk = (data: VoiceAudioChunkPayload) => {
      emitAudioChunk(data);
    };

    const handleVoiceStopAudio = (data: VoiceStopAudioPayload) => {
      emitStopAudio(data);
    };

    const handleVoiceLatency = (data: VoiceLatencyPayload) => {
      setVoiceLatency({
        sttMs: data.sttMs,
        firstTokenMs: data.firstTokenMs,
        firstAudioMs: data.firstAudioMs,
        totalMs: data.totalMs,
      });
      pushActivity({
        sessionId: data.sessionId,
        ts: new Date().toISOString(),
        kind: 'voice_latency',
        summary: `speech->transcript ${data.sttMs}ms · transcript->reply ${data.firstTokenMs}ms · reply->audio ${data.firstAudioMs}ms · total ${data.totalMs}ms`,
      });
    };

    // ---- Event-driven subagent follow-ups (S14-B) ----
    const handleFollowupQueued = (data: FollowupQueuedPayload) => {
      markFollowupQueued(data.agentId);
      pushActivity({
        sessionId: data.sessionId,
        ts: new Date().toISOString(),
        kind: 'followup',
        summary: `Follow-up queued for agent ${data.agentId}`,
        subagentId: data.agentId,
      });
    };

    const handleFollowupDelivered = (data: FollowupDeliveredPayload) => {
      clearFollowupQueued(data.agentIds);
      pushActivity({
        sessionId: data.sessionId,
        ts: new Date().toISOString(),
        kind: 'followup',
        summary: `Follow-up delivered (${data.agentIds.length} agent${data.agentIds.length === 1 ? '' : 's'})`,
      });
    };

    // Register all listeners
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);
    socket.on('message:user', handleUserMessage);
    socket.on('message:stream:start', handleStreamStart);
    socket.on('message:stream:delta', handleStreamDelta);
    socket.on('message:stream:tool', handleStreamTool);
    socket.on('message:stream:tool_result', handleStreamToolResult);
    socket.on('message:stream:end', handleStreamEnd);
    socket.on('message:error', handleMessageError);
    socket.on('session:status', handleSessionStatus);
    socket.on('session:yolo-changed', handleYoloChanged);
    socket.on('session:system-prompt-changed', handleSystemPromptChanged);
    socket.on('session:skills-changed', handleSkillsChanged);
    socket.on('session:working-dir-changed', handleWorkingDirChanged);
    socket.on('subagent:start', handleSubagentStart);
    socket.on('subagent:delta', handleSubagentDelta);
    socket.on('subagent:tool', handleSubagentTool);
    socket.on('subagent:end', handleSubagentEnd);
    socket.on('activity:event', handleActivityEvent);
    socket.on('server:shutting-down', handleServerShuttingDown);
    socket.on('voice:state', handleVoiceState);
    socket.on('voice:partial', handleVoicePartial);
    socket.on('voice:transcript', handleVoiceTranscript);
    socket.on('voice:audio-chunk', handleVoiceAudioChunk);
    socket.on('voice:stop-audio', handleVoiceStopAudio);
    socket.on('voice:latency', handleVoiceLatency);
    socket.on('followup:queued', handleFollowupQueued);
    socket.on('followup:delivered', handleFollowupDelivered);

    return () => {
      // CRITICAL: Remove all listeners before disconnecting to prevent memory leaks
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off('message:user', handleUserMessage);
      socket.off('message:stream:start', handleStreamStart);
      socket.off('message:stream:delta', handleStreamDelta);
      socket.off('message:stream:tool', handleStreamTool);
      socket.off('message:stream:tool_result', handleStreamToolResult);
      socket.off('message:stream:end', handleStreamEnd);
      socket.off('message:error', handleMessageError);
      socket.off('session:status', handleSessionStatus);
      socket.off('session:yolo-changed', handleYoloChanged);
      socket.off('session:system-prompt-changed', handleSystemPromptChanged);
      socket.off('session:skills-changed', handleSkillsChanged);
      socket.off('session:working-dir-changed', handleWorkingDirChanged);
      socket.off('subagent:start', handleSubagentStart);
      socket.off('subagent:delta', handleSubagentDelta);
      socket.off('subagent:tool', handleSubagentTool);
      socket.off('subagent:end', handleSubagentEnd);
      socket.off('activity:event', handleActivityEvent);
      socket.off('server:shutting-down', handleServerShuttingDown);
      socket.off('voice:state', handleVoiceState);
      socket.off('voice:partial', handleVoicePartial);
      socket.off('voice:transcript', handleVoiceTranscript);
      socket.off('voice:audio-chunk', handleVoiceAudioChunk);
      socket.off('voice:stop-audio', handleVoiceStopAudio);
      socket.off('voice:latency', handleVoiceLatency);
      socket.off('followup:queued', handleFollowupQueued);
      socket.off('followup:delivered', handleFollowupDelivered);

      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);

      disconnectSocket();
      socketRef.current = null;
      setConnected(false);
    };
    // Only run on mount/unmount -- store actions are stable references
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fix race condition: handleConnect fires before fetchSessions() resolves,
  // leaving session rooms unjoined. Re-emit session:join whenever sessions
  // populate OR connection is re-established so io.to(sessionId) events reach us.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !connected || sessions.length === 0) return;
    for (const s of sessions) {
      socket.emit('session:join', { sessionId: s.id });
    }
  }, [sessions, connected]);

  return { socket: socketRef.current, connected };
}
