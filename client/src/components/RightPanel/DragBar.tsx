import { useCallback, useEffect, useRef, useState } from 'react';

interface DragBarProps {
  /**
   * Called with the pointer's viewport x while dragging. The caller converts
   * that into a width, because only it knows which edge the panel hangs off.
   */
  onDrag: (clientX: number) => void;
  onDoubleClick?: () => void;
  title?: string;
}

/**
 * A 5px vertical grab handle between two columns.
 *
 * Pointer capture plus a body-level `user-select: none` while dragging: without
 * both, a fast drag across the chat text selects half the transcript and the
 * pointer escapes the 5px strip.
 */
export default function DragBar({ onDrag, onDoubleClick, title }: DragBarProps) {
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    ref.current?.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      onDrag(e.clientX);
    },
    [dragging, onDrag],
  );

  const stop = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    ref.current?.releasePointerCapture?.(e.pointerId);
    setDragging(false);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.body.style.userSelect = prev;
      document.body.style.cursor = '';
    };
  }, [dragging]);

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      title={title}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onDoubleClick}
      style={{
        ...styles.bar,
        background: dragging ? 'var(--accent)' : 'transparent',
      }}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    width: 5,
    flexShrink: 0,
    cursor: 'col-resize',
    borderLeft: '1px solid var(--border)',
    transition: 'background 0.12s',
  },
};
