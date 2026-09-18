import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useSocket } from './hooks/useSocket';
import { useSessionStore } from './stores/sessionStore';
import { useProjectStore } from './stores/projectStore';
import { useFileDropStore } from './stores/fileDropStore';
import { useLayoutStore, ACTIVITY_MIN_WIDTH, ACTIVITY_MAX_WIDTH } from './stores/layoutStore';
import { useTasksStore } from './stores/tasksStore';
import LoginScreen from './components/Auth/LoginScreen';
import Sidebar from './components/Sidebar/Sidebar';
import ProjectPane from './components/Project/ProjectPane';
import ChatView from './components/Chat/ChatView';
import LaunchScreen from './components/Chat/LaunchScreen';
import ToolsView from './components/Tools/ToolsView';
import RightPanel from './components/RightPanel/RightPanel';
import DragBar from './components/RightPanel/DragBar';
import ActivityLogPanel from './components/Activity/ActivityLogPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import CaffeineToggle from './components/Caffeine/CaffeineToggle';
import OnboardingView from './components/Onboarding/OnboardingView';
import { checkAuth } from './api';
import { useTtsStore } from './stores/ttsStore';
import { applySavedLayer, importPackFile, isPackFile } from './packs';

const ONBOARDING_KEY = 'medusa_onboarding_done';
// Show launch screen once per browser session (sessionStorage resets on tab close)
const LAUNCH_KEY = 'medusa_launch_shown';

export default function App() {
  // null = checking auth, false = not authed, true = authed
  const [authed, setAuthed] = useState<boolean | null>(null);
  // Track whether we were kicked out due to socket auth failure vs first visit
  const [authFailed, setAuthFailed] = useState(false);

  // On mount, ask the server if our cookie is valid instead of reading localStorage
  useEffect(() => {
    checkAuth().then(setAuthed);
  }, []);

  // Listen for socket auth failures (e.g. after sleep/wake cookie mismatch)
  // and force the user back to login.
  useEffect(() => {
    const handleAuthFailed = () => {
      console.log('[app] Socket auth failed, showing login screen');
      setAuthFailed(true);
      setAuthed(false);
    };
    window.addEventListener('medusa:auth-failed', handleAuthFailed);
    return () => window.removeEventListener('medusa:auth-failed', handleAuthFailed);
  }, []);

  const handleLogin = useCallback(() => {
    setAuthFailed(false);
    setAuthed(true);
  }, []);

  // Still checking cookie validity: render nothing to avoid flash
  if (authed === null) return null;

  if (!authed) {
    return (
      <LoginScreen
        onLogin={handleLogin}
        reason={authFailed ? 'Session expired, please log in again' : undefined}
      />
    );
  }

  // Render the main app only after auth succeeds, so the WebSocket
  // connection (in useSocket) is established with the auth cookie present.
  return <AuthenticatedApp />;
}

/**
 * Inner component that only mounts after authentication.
 * This ensures the WebSocket connects with the auth cookie already set.
 */
function AuthenticatedApp() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // First-launch gate, checked synchronously so there is no flash
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem(ONBOARDING_KEY));
  const completeOnboarding = useCallback(() => {
    localStorage.setItem(ONBOARDING_KEY, '1');
    setShowOnboarding(false);
  }, []);

  // Launch screen, shown once per session (sessionStorage resets on tab close)
  const [showLaunch, setShowLaunch] = useState(() => !sessionStorage.getItem(LAUNCH_KEY));
  const dismissLaunch = useCallback(() => {
    sessionStorage.setItem(LAUNCH_KEY, '1');
    setShowLaunch(false);
  }, []);

  const { connected } = useSocket();
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const activeView = useSessionStore((s) => s.activeView);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);

  const panelState = useLayoutStore((s) => s.panelState);
  const slimWidth = useLayoutStore((s) => s.slimWidth);
  const wideWidth = useLayoutStore((s) => s.wideWidth);
  const setPanelWidth = useLayoutStore((s) => s.setPanelWidth);
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const toggleSlimWide = useLayoutStore((s) => s.toggleSlimWide);
  const activityOpen = useLayoutStore((s) => s.activityOpen);
  const activityWidth = useLayoutStore((s) => s.activityWidth);
  const setActivityWidth = useLayoutStore((s) => s.setActivityWidth);
  const toggleActivity = useLayoutStore((s) => s.toggleActivity);
  const toggleTasksTab = useLayoutStore((s) => s.toggleTab);
  const hydrateTasks = useTasksStore((s) => s.hydrate);

  const isDragging = useFileDropStore((s) => s.isDragging);
  const setDragging = useFileDropStore((s) => s.setDragging);
  const addFiles = useFileDropStore((s) => s.addFiles);

  // Track drag enter/leave depth so nested elements don't flicker the overlay
  const dragCounterRef = useRef(0);

  // Fetch data immediately on mount (we're already authenticated at this point)
  useEffect(() => {
    fetchSessions().catch(console.error);
    fetchProjects().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The Medusa layer's theme and voice are served to the client on load, so a
  // saved theme paints before the first chat renders instead of flashing the
  // shipped one first.
  useEffect(() => {
    const store = useTtsStore.getState();
    void applySavedLayer((v) => {
      store.setVoice(v.voiceId);
      store.setSpeed(v.speed);
      store.setSpeak(v.enabled);
    });
  }, []);

  // Re-fetch when socket (re)connects to pick up any changes
  useEffect(() => {
    if (connected) {
      fetchSessions().catch(console.error);
      fetchProjects().catch(console.error);
    }
  }, [connected, fetchSessions, fetchProjects]);

  // Cmd+B toggles the Browser/Simulator panel, Cmd+L the Activity Log,
  // Cmd+Shift+T opens the panel on the Tasks tab (plain Cmd+T is the browser's
  // own "new tab" shortcut, so it is never seen by page JS -- Shift avoids
  // that collision).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === 't') {
        e.preventDefault();
        toggleTasksTab('tasks');
        return;
      }
      if (e.shiftKey || e.altKey) return;
      if (key === 'b') {
        e.preventDefault();
        togglePanel();
      } else if (key === 'l') {
        e.preventDefault();
        toggleActivity();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePanel, toggleActivity, toggleTasksTab]);

  // Hydrate the Tasks panel once on load so a reload still shows what is
  // running instead of coming up empty until the next socket event.
  useEffect(() => {
    void hydrateTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Global drag-and-drop handlers ---

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) {
      // Only show overlay if the drag contains files
      const hasFiles = e.dataTransfer.types.includes('Files');
      if (hasFiles) setDragging(true);
    }
  }, [setDragging]);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    // Required to allow drop
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setDragging(false);
    }
  }, [setDragging]);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    // A Medusa pack dropped on the window is an import, not an attachment.
    // The server validates it and backs up the current setup before applying.
    const packs = droppedFiles.filter(isPackFile);
    for (const pack of packs) {
      importPackFile(pack)
        .then((manifest) => {
          window.alert(`Applied "${manifest.name}". Your previous setup was backed up.`);
        })
        .catch((err: Error) => window.alert(err.message));
    }
    const rest = droppedFiles.filter((f) => !isPackFile(f));
    if (rest.length === 0) return;

    // Enforce 20MB per-file limit (match server)
    const MAX_SIZE = 20 * 1024 * 1024;
    const validFiles = rest.filter((f) => f.size <= MAX_SIZE);

    if (validFiles.length === 0) return;

    const entries = validFiles.map((file) => {
      const isImage = file.type.startsWith('image/');
      return {
        file,
        preview: isImage ? URL.createObjectURL(file) : '',
        isImage,
      };
    });

    addFiles(entries);
  }, [setDragging, addFiles]);

  // The panel's drag bar sits to the LEFT of the panel, so the panel's width is
  // whatever remains between the pointer and the right-hand edge of the app
  // (minus the Activity Log when it is open).
  const handlePanelDrag = useCallback(
    (clientX: number) => {
      const rightEdge = window.innerWidth - (activityOpen ? activityWidth + 5 : 0);
      setPanelWidth(rightEdge - clientX);
    },
    [activityOpen, activityWidth, setPanelWidth],
  );

  const handleActivityDrag = useCallback(
    (clientX: number) => setActivityWidth(window.innerWidth - clientX),
    [setActivityWidth],
  );

  const panelVisible = panelState !== 'hidden';
  const panelPx = panelState === 'slim' ? slimWidth : wideWidth;

  const mainColumn =
    activeView === 'project' ? (
      <ErrorBoundary>
        <ProjectPane onMenuToggle={() => setSidebarOpen((o) => !o)} />
      </ErrorBoundary>
    ) : activeView === 'tools' ? (
      <ErrorBoundary>
        <ToolsView />
      </ErrorBoundary>
    ) : (
      <ErrorBoundary>
        <ChatView onMenuToggle={() => setSidebarOpen((o) => !o)} />
      </ErrorBoundary>
    );

  return (
    <ErrorBoundary>
      {/* Launch splash, shown once per session, above everything */}
      {showLaunch && <LaunchScreen onDismiss={dismissLaunch} />}

      {/* First-launch onboarding, renders above the main app */}
      {!showLaunch && showOnboarding && <OnboardingView onComplete={completeOnboarding} />}

      <div
        className="app-layout"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drop overlay */}
        {isDragging && <DropOverlay />}

        {/* Caffeine toggle: fixed top-right, visible on all panes */}
        <CaffeineToggle />

        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        {/* Center: chat (or Projects / Tools). `full` hands the whole middle
            over to the panel, which is what the addendum's "full" state means. */}
        {panelState !== 'full' && (
          <div style={centerStyles.center}>{mainColumn}</div>
        )}

        {panelVisible && (
          <>
            {panelState !== 'full' && (
              <DragBar
                onDrag={handlePanelDrag}
                onDoubleClick={toggleSlimWide}
                title="Drag to resize, double-click for slim or wide"
              />
            )}
            <div
              style={{
                ...centerStyles.panel,
                width: panelState === 'full' ? undefined : panelPx,
                flex: panelState === 'full' ? 1 : undefined,
              }}
            >
              <ErrorBoundary>
                <RightPanel />
              </ErrorBoundary>
            </div>
          </>
        )}

        {/* Far right: Activity Log, with its own drag bar and `<` handle */}
        {activityOpen ? (
          <>
            <DragBar onDrag={handleActivityDrag} title="Drag to resize the Activity Log" />
            <div
              style={{
                ...centerStyles.panel,
                width: Math.min(ACTIVITY_MAX_WIDTH, Math.max(ACTIVITY_MIN_WIDTH, activityWidth)),
              }}
            >
              <ErrorBoundary>
                {/* The panel keys its ring buffer by session id; with no chat
                    selected there is nothing to show, so '' yields an empty log
                    rather than an extra empty-state branch inside the panel. */}
                <ActivityLogPanel sessionId={activeSessionId ?? ''} />
              </ErrorBoundary>
            </div>
          </>
        ) : (
          <button
            onClick={toggleActivity}
            style={centerStyles.activityHandle}
            title="Open the Activity Log (⌘L)"
            aria-label="Open the Activity Log"
          >
            ‹
          </button>
        )}
      </div>
    </ErrorBoundary>
  );
}

const centerStyles: Record<string, React.CSSProperties> = {
  center: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  panel: {
    flexShrink: 0,
    minWidth: 0,
    height: '100%',
    overflow: 'hidden',
  },
  activityHandle: {
    width: 16,
    flexShrink: 0,
    background: 'var(--bg-tertiary)',
    borderLeft: '1px solid var(--border)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: 13,
    padding: 0,
  },
};

/** Full-viewport overlay shown while dragging files over the app */
function DropOverlay() {
  return (
    <div style={dropStyles.overlay}>
      <div style={dropStyles.inner}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(26, 122, 60, 0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="18" x2="12" y2="12" />
          <line x1="9" y1="15" x2="12" y2="12" />
          <line x1="15" y1="15" x2="12" y2="12" />
        </svg>
        <span style={dropStyles.text}>Drop files here</span>
      </div>
    </div>
  );
}

const dropStyles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 500,
    background: 'rgba(26, 122, 60, 0.08)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    animation: 'dropOverlayIn 150ms ease-out',
  },
  inner: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: '40px 60px',
    border: '2px dashed rgba(26, 122, 60, 0.4)',
    borderRadius: 16,
    background: 'rgba(26, 26, 28, 0.85)',
  },
  text: {
    fontSize: 16,
    fontWeight: 600,
    color: 'rgba(26, 122, 60, 0.8)',
    letterSpacing: '0.02em',
  },
};
