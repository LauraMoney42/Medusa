import { useState, useEffect, useCallback } from 'react';
import {
  captureScreenFrame,
  captureRegionFrame,
  isNativeRegionPickerAvailable,
} from './captureScreen';
import RegionSelector from './RegionSelector';

// captureScreen.ts handles WKWebView gracefully: falls back to a file picker when
// getDisplayMedia is unavailable. No need to hide the button — always render it.

interface ScreenshotButtonProps {
  onCapture: (file: File, preview: string) => void;
  disabled?: boolean;
}

export default function ScreenshotButton({ onCapture, disabled }: ScreenshotButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [regionImage, setRegionImage] = useState<string | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  const handleFullScreen = async () => {
    setMenuOpen(false);
    const blob = await captureScreenFrame();
    if (!blob) return;

    const file = new File([blob], 'screenshot.png', { type: 'image/png' });
    const preview = URL.createObjectURL(blob);
    onCapture(file, preview);
  };

  const handleRegionSelect = async () => {
    setMenuOpen(false);

    if (isNativeRegionPickerAvailable()) {
      // SC6: native fullscreen overlay returns the already-cropped region PNG.
      // No React crop step needed — the user selects the exact region in Swift.
      const blob = await captureRegionFrame();
      if (!blob) return;
      const file = new File([blob], 'screenshot-region.png', { type: 'image/png' });
      const preview = URL.createObjectURL(blob);
      onCapture(file, preview);
    } else {
      // Browser fallback: capture the full screen then show the React crop overlay.
      const blob = await captureScreenFrame();
      if (!blob) return;
      setRegionImage(URL.createObjectURL(blob));
    }
  };

  const handleCrop = useCallback((blob: Blob) => {
    const file = new File([blob], 'screenshot-region.png', { type: 'image/png' });
    const preview = URL.createObjectURL(blob);
    onCapture(file, preview);
    setRegionImage(null);
  }, [onCapture]);

  const handleCancelRegion = useCallback(() => {
    setRegionImage(null);
  }, []);

  return (
    <div style={styles.container}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((prev) => !prev);
        }}
        disabled={disabled}
        style={{
          ...styles.button,
          opacity: disabled ? 0.4 : 1,
        }}
        title="Take screenshot"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </button>

      {/* Dropdown menu (opens upward) */}
      {menuOpen && (
        <div
          style={styles.menu}
          onClick={(e) => e.stopPropagation()}
        >
          <button style={styles.menuItem} onClick={handleRegionSelect}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8, flexShrink: 0 }}>
              <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
            </svg>
            Region Select
          </button>
          <button style={styles.menuItem} onClick={handleFullScreen}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8, flexShrink: 0 }}>
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            Full Screen
          </button>
        </div>
      )}

      {/* Region selector overlay */}
      {regionImage && (
        <RegionSelector
          imageSrc={regionImage}
          onCrop={handleCrop}
          onCancel={handleCancelRegion}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  button: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'transparent',
    color: 'var(--text-secondary)',
    flexShrink: 0,
    cursor: 'pointer',
    border: 'none',
    transition: 'color 0.15s',
  },
  menu: {
    position: 'absolute',
    bottom: '100%',
    right: 0,
    marginBottom: 8,
    background: '#2c2c2e',
    border: '1px solid rgba(255, 255, 255, 0.10)',
    borderRadius: 'var(--radius)',
    padding: 6,
    zIndex: 200,
    boxShadow: '0 12px 48px rgba(0, 0, 0, 0.5)',
    minWidth: 170,
  } as React.CSSProperties,
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    textAlign: 'left',
    padding: '8px 14px',
    fontSize: 14,
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
};
