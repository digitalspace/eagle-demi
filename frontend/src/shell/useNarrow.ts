import { useCallback, useSyncExternalStore } from 'react';

/**
 * Below this the navigation rail goes off-canvas: a fixed 250px rail leaves a 390px phone about
 * 140px for the screen itself.
 */
export const SHELL_NARROW_QUERY = '(max-width: 899.98px)';

export function useNarrow(media: string = SHELL_NARROW_QUERY): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const query = window.matchMedia(media);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    [media],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(media).matches);
}
