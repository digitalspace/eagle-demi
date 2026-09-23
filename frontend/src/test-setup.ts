import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';

// jsdom ships no media queries. The shell reads one to decide its layout, so tests get a wide
// viewport by default and narrow ones call stubNarrow().
export function stubNarrow(matches: boolean) {
  window.matchMedia = (media: string) =>
    ({
      matches,
      media,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

beforeEach(() => stubNarrow(false));
