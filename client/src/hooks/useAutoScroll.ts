import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeps a scrollable container pinned to the bottom when new content
 * arrives, unless the user has manually scrolled up.
 */
export function useAutoScroll(dep: unknown) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const checkIsAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    // Allow a small threshold (24px) to account for rounding
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setIsAtBottom(true);
  }, []);

  // Track user scroll position
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      setIsAtBottom(checkIsAtBottom());
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [checkIsAtBottom]);

  // Auto-scroll when dependency changes (new messages / deltas)
  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom();
    }
    // dep is an external trigger value that changes on new content
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep, isAtBottom, scrollToBottom]);

  return { containerRef, isAtBottom, scrollToBottom };
}
