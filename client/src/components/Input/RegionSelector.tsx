import { useState, useRef, useEffect, useCallback } from 'react';

interface RegionSelectorProps {
  imageSrc: string;
  onCrop: (blob: Blob) => void;
  onCancel: () => void;
}

interface Point {
  x: number;
  y: number;
}

export default function RegionSelector({ imageSrc, onCrop, onCancel }: RegionSelectorProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [dragging, setDragging] = useState(false);
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [endPoint, setEndPoint] = useState<Point | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  // Escape key to cancel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  // Cleanup the object URL when unmounting
  useEffect(() => {
    return () => URL.revokeObjectURL(imageSrc);
  }, [imageSrc]);

  const getPointerPos = (e: React.MouseEvent | React.TouchEvent): Point => {
    if ('touches' in e) {
      const touch = e.touches[0] || (e as React.TouchEvent).changedTouches[0];
      return { x: touch.clientX, y: touch.clientY };
    }
    return { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };
  };

  const handlePointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    // Don't start a new drag if we already have a confirmed selection
    if (confirmed) return;
    const pos = getPointerPos(e);
    setStartPoint(pos);
    setEndPoint(pos);
    setDragging(true);
  };

  const handlePointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!dragging) return;
    setEndPoint(getPointerPos(e));
  };

  const handlePointerUp = () => {
    if (!dragging) return;
    setDragging(false);

    // Ignore too-small selections
    if (startPoint && endPoint) {
      const w = Math.abs(endPoint.x - startPoint.x);
      const h = Math.abs(endPoint.y - startPoint.y);
      if (w < 10 || h < 10) {
        setStartPoint(null);
        setEndPoint(null);
        return;
      }
      setConfirmed(true);
    }
  };

  const handleCrop = useCallback(async () => {
    if (!startPoint || !endPoint || !imgRef.current) return;

    const imgEl = imgRef.current;
    const rect = imgEl.getBoundingClientRect();

    const scaleX = imgEl.naturalWidth / rect.width;
    const scaleY = imgEl.naturalHeight / rect.height;

    const selLeft = Math.min(startPoint.x, endPoint.x);
    const selTop = Math.min(startPoint.y, endPoint.y);
    const selW = Math.abs(endPoint.x - startPoint.x);
    const selH = Math.abs(endPoint.y - startPoint.y);

    // Convert from viewport coords to image-relative coords
    let cropX = (selLeft - rect.left) * scaleX;
    let cropY = (selTop - rect.top) * scaleY;
    let cropW = selW * scaleX;
    let cropH = selH * scaleY;

    // Clamp to image bounds
    cropX = Math.max(0, cropX);
    cropY = Math.max(0, cropY);
    cropW = Math.min(cropW, imgEl.naturalWidth - cropX);
    cropH = Math.min(cropH, imgEl.naturalHeight - cropY);

    const canvas = document.createElement('canvas');
    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(imgEl, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    canvas.toBlob((blob) => {
      if (blob) onCrop(blob);
    }, 'image/png');
  }, [startPoint, endPoint, onCrop]);

  const handleReset = () => {
    setStartPoint(null);
    setEndPoint(null);
    setConfirmed(false);
  };

  // Selection rectangle bounds
  const sel = startPoint && endPoint ? {
    left: Math.min(startPoint.x, endPoint.x),
    top: Math.min(startPoint.y, endPoint.y),
    width: Math.abs(endPoint.x - startPoint.x),
    height: Math.abs(endPoint.y - startPoint.y),
  } : null;

  const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0;

  return (
    <div
      style={styles.overlay}
      onMouseDown={handlePointerDown}
      onMouseMove={handlePointerMove}
      onMouseUp={handlePointerUp}
      onTouchStart={handlePointerDown}
      onTouchMove={handlePointerMove}
      onTouchEnd={handlePointerUp}
    >
      {/* Captured screenshot as background */}
      <img
        ref={imgRef}
        src={imageSrc}
        alt=""
        style={styles.bgImage}
        draggable={false}
      />

      {/* Dimming overlays (four rectangles around selection) */}
      {sel && sel.width > 0 && sel.height > 0 && (
        <>
          {/* Top */}
          <div style={{ ...styles.dim, top: 0, left: 0, width: vw, height: sel.top }} />
          {/* Bottom */}
          <div style={{ ...styles.dim, top: sel.top + sel.height, left: 0, width: vw, height: vh - sel.top - sel.height }} />
          {/* Left */}
          <div style={{ ...styles.dim, top: sel.top, left: 0, width: sel.left, height: sel.height }} />
          {/* Right */}
          <div style={{ ...styles.dim, top: sel.top, left: sel.left + sel.width, width: vw - sel.left - sel.width, height: sel.height }} />
        </>
      )}

      {/* No selection yet — full dim + instruction */}
      {!sel && (
        <div style={styles.dimFull} />
      )}

      {/* Selection rectangle */}
      {sel && sel.width > 0 && sel.height > 0 && (
        <div
          style={{
            position: 'fixed',
            left: sel.left,
            top: sel.top,
            width: sel.width,
            height: sel.height,
            border: '2px dashed rgba(255,255,255,0.8)',
            pointerEvents: 'none',
            zIndex: 10002,
          }}
        />
      )}

      {/* Instruction tooltip */}
      <div style={styles.tooltip}>
        {confirmed ? 'Crop this region?' : 'Drag to select a region. Press Esc to cancel.'}
      </div>

      {/* Confirm / Cancel buttons after selection */}
      {confirmed && sel && (
        <div
          style={{
            position: 'fixed',
            left: sel.left + sel.width / 2,
            top: sel.top + sel.height + 12,
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: 8,
            zIndex: 10003,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <button onClick={handleCrop} style={styles.captureBtn}>
            Capture
          </button>
          <button onClick={handleReset} style={styles.retryBtn}>
            Retry
          </button>
          <button onClick={onCancel} style={styles.cancelBtn}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    cursor: 'crosshair',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  bgImage: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    pointerEvents: 'none',
    zIndex: 10000,
  },
  dim: {
    position: 'fixed',
    background: 'rgba(0, 0, 0, 0.5)',
    pointerEvents: 'none',
    zIndex: 10001,
  },
  dimFull: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.3)',
    pointerEvents: 'none',
    zIndex: 10001,
  },
  tooltip: {
    position: 'fixed',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(0, 0, 0, 0.75)',
    color: '#fff',
    padding: '8px 16px',
    borderRadius: 20,
    fontSize: 14,
    fontWeight: 500,
    zIndex: 10003,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  },
  captureBtn: {
    padding: '6px 16px',
    borderRadius: 6,
    background: 'var(--accent)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
  },
  retryBtn: {
    padding: '6px 16px',
    borderRadius: 6,
    background: 'rgba(255,255,255,0.15)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.3)',
  },
  cancelBtn: {
    padding: '6px 16px',
    borderRadius: 6,
    background: 'rgba(255,255,255,0.15)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.3)',
  },
};
