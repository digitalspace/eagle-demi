import { useSyncExternalStore } from 'react';

/**
 * Below this the navigation rail goes off-canvas: a fixed 250px rail leaves a 390px phone about
 * 140px for the screen itself.
 */
export const SHELL_NARROW_QUERY = '(max-width: 899.98px)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(SHELL_NARROW_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(SHELL_NARROW_QUERY).matches);
}
