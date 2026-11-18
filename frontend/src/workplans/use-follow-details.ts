import { useLayoutEffect, type RefObject } from 'react';

/**
 * While `active`, calls `reveal` each time the panel changes size, so details coming in are scrolled into view.
 * Stops, and calls `onDone`, once nothing in the panel is busy, so later resizes leave the scroll alone.
 */
export function useFollowDetails(
  panel: RefObject<HTMLElement | null>,
  active: boolean,
  reveal: (panel: HTMLElement) => void,
  onDone: () => void,
) {
  useLayoutEffect(() => {
    const el = panel.current;
    if (!active || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      reveal(el);
      if (el.querySelector('[aria-busy="true"]')) return;
      observer.disconnect();
      onDone();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [panel, active, reveal, onDone]);
}
