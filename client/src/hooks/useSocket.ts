import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket, disconnectSocket } from '../socket';
import { useChatStore } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { useHubStore } from '../stores/hubStore';
import { useTaskStore } from '../stores/taskStore';
import type { ChatMessage, ToolUse } from '../types/message';
import type { HubMessage } from '../types/hub';
import type { CompletedTask } from '../types/task';

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
  const finishStreaming = useChatStore((s) => s.finishStreaming);
  const setError = useChatStore((s) => s.setError);
  const setSessionStatus = useSessionStore((s) => s.setSessionStatus);
  const setSessionYolo = useSessionStore((s) => s.setSessionYolo);
  const setSessionSystemPrompt = useSessionStore((s) => s.setSessionSystemPrompt);
  const setSessionSkills = useSessionStore((s) => s.setSessionSkills);
  const setSessionWorkingDir = useSessionStore((s) => s.setSessionWorkingDir);
  const addHubMessage = useHubStore((s) => s.addMessage);
  const addTask = useTaskStore((s) => s.addTask);
  const setPendingTask = useSessionStore((s) => s.setPendingTask);
  const setServerShuttingDown = useSessionStore((s) => s.setServerShuttingDown);

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

    const handleDisconnect = () => setConnected(false);

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

    const handleHubMessage = (msg: HubMessage) => {
      console.log('[hub] received hub:message', msg);
      addHubMessage(msg);
    };

    const handleTaskDone = (task: CompletedTask) => {
      addTask(task);
    };

    const handlePendingTask = (data: { sessionId: string; hasPendingTask: boolean }) => {
      setPendingTask(data.sessionId, data.hasPendingTask);
    };

    const handleTasksAcknowledged = () => {
      useTaskStore.getState().clearAll();
    };

    const handleServerShuttingDown = (data: { busySessions: { id: string; name: string }[] }) => {
      console.log('[socket] Server shutting down, waiting for:', data.busySessions);
      setServerShuttingDown(data.busySessions);
    };

    // Register all listeners
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('message:user', handleUserMessage);
    socket.on('message:stream:start', handleStreamStart);
    socket.on('message:stream:delta', handleStreamDelta);
    socket.on('message:stream:tool', handleStreamTool);
    socket.on('message:stream:end', handleStreamEnd);
    socket.on('message:error', handleMessageError);
    socket.on('session:status', handleSessionStatus);
    socket.on('session:yolo-changed', handleYoloChanged);
    socket.on('session:system-prompt-changed', handleSystemPromptChanged);
    socket.on('session:skills-changed', handleSkillsChanged);
    socket.on('session:working-dir-changed', handleWorkingDirChanged);
    socket.on('hub:message', handleHubMessage);
    socket.on('task:done', handleTaskDone);
    socket.on('session:pending-task', handlePendingTask);
    socket.on('tasks:acknowledged', handleTasksAcknowledged);
    socket.on('server:shutting-down', handleServerShuttingDown);

    return () => {
      // CRITICAL: Remove all listeners before disconnecting to prevent memory leaks
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('message:user', handleUserMessage);
      socket.off('message:stream:start', handleStreamStart);
      socket.off('message:stream:delta', handleStreamDelta);
      socket.off('message:stream:tool', handleStreamTool);
      socket.off('message:stream:end', handleStreamEnd);
      socket.off('message:error', handleMessageError);
      socket.off('session:status', handleSessionStatus);
      socket.off('session:yolo-changed', handleYoloChanged);
      socket.off('session:system-prompt-changed', handleSystemPromptChanged);
      socket.off('session:skills-changed', handleSkillsChanged);
      socket.off('session:working-dir-changed', handleWorkingDirChanged);
      socket.off('hub:message', handleHubMessage);
      socket.off('task:done', handleTaskDone);
      socket.off('session:pending-task', handlePendingTask);
      socket.off('tasks:acknowledged', handleTasksAcknowledged);
      socket.off('server:shutting-down', handleServerShuttingDown);

      disconnectSocket();
      socketRef.current = null;
      setConnected(false);
    };
    // Only run on mount/unmount -- store actions are stable references
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { socket: socketRef.current, connected };
}
