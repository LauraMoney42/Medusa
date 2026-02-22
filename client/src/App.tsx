import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useSocket } from './hooks/useSocket';
import { useSessionStore } from './stores/sessionStore';
import { useHubStore } from './stores/hubStore';
import { useTaskStore } from './stores/taskStore';
import { useProjectStore } from './stores/projectStore';
import { useImageDropStore } from './stores/imageDropStore';
import LoginScreen from './components/Auth/LoginScreen';
import Sidebar from './components/Sidebar/Sidebar';
import HubFeed from './components/Hub/HubFeed';
import ProjectPane from './components/Project/ProjectPane';
import { ErrorBoundary } from './components/ErrorBoundary';
import CaffeineToggle from './components/Caffeine/CaffeineToggle';
import OnboardingView from './components/Onboarding/OnboardingView';
import { checkAuth } from './api';

const ONBOARDING_KEY = 'medusa_onboarding_done';

export default function App() {
  // null = checking auth, false = not authed, true = authed
  const [authed, setAuthed] = useState<boolean | null>(null);

  // On mount, ask the server if our cookie is valid instead of reading localStorage
  useEffect(() => {
    checkAuth().then(setAuthed);
  }, []);

  const handleLogin = useCallback(() => {
    setAuthed(true);
  }, []);

  // Still checking cookie validity — render nothing to avoid flash
  if (authed === null) return null;

  if (!authed) {
    return <LoginScreen onLogin={handleLogin} />;
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
  // First-launch gate — checked synchronously so there's no flash
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem(ONBOARDING_KEY));
  const completeOnboarding = useCallback(() => {
    localStorage.setItem(ONBOARDING_KEY, '1');
    setShowOnboarding(false);
  }, []);

  const { connected } = useSocket();
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const activeView = useSessionStore((s) => s.activeView);
  const fetchHubMessages = useHubStore((s) => s.fetchMessages);
  const fetchTasks = useTaskStore((s) => s.fetchTasks);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);

  const isDragging = useImageDropStore((s) => s.isDragging);
  const setDragging = useImageDropStore((s) => s.setDragging);
  const addImages = useImageDropStore((s) => s.addImages);

  // Track drag enter/leave depth so nested elements don't flicker the overlay
  const dragCounterRef = useRef(0);

  // Fetch data immediately on mount (we're already authenticated at this point)
  useEffect(() => {
    fetchSessions().catch(console.error);
    fetchHubMessages().catch(console.error);
    fetchTasks().catch(console.error);
    fetchProjects().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when socket (re)connects to pick up any changes
  useEffect(() => {
    if (connected) {
      fetchSessions().catch(console.error);
      fetchHubMessages().catch(console.error);
      fetchTasks().catch(console.error);
      fetchProjects().catch(console.error);
    }
  }, [connected, fetchSessions, fetchHubMessages, fetchTasks, fetchProjects]);

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

    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));

    if (imageFiles.length === 0) return;

    // Enforce 20MB per-file limit (match server)
    const MAX_SIZE = 20 * 1024 * 1024;
    const validFiles = imageFiles.filter((f) => f.size <= MAX_SIZE);

    if (validFiles.length === 0) return;

    const entries = validFiles.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));

    addImages(entries);
  }, [setDragging, addImages]);

  return (
    <ErrorBoundary>
      {/* First-launch onboarding — renders above everything */}
      {showOnboarding && <OnboardingView onComplete={completeOnboarding} />}

      <div
        className="app-layout"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drop overlay */}
        {isDragging && <DropOverlay />}

        {/* Caffeine toggle — fixed top-right, visible on all panes */}
        <CaffeineToggle />

        <Sidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
        {activeView === 'project' ? (
          <ErrorBoundary>
            <ProjectPane onMenuToggle={() => setSidebarOpen((o) => !o)} />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary>
            <HubFeed onMenuToggle={() => setSidebarOpen((o) => !o)} />
          </ErrorBoundary>
        )}
      </div>
    </ErrorBoundary>
  );
}

/** Full-viewport overlay shown while dragging an image over the app */
function DropOverlay() {
  return (
    <div style={dropStyles.overlay}>
      <div style={dropStyles.inner}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(26, 122, 60, 0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span style={dropStyles.text}>Drop image here</span>
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
