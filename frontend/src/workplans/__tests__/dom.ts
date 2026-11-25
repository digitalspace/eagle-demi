import { vi } from 'vitest';

/** jsdom has no ResizeObserver; the Workplans scroll boxes only need one to exist. Undone by `vi.unstubAllGlobals()`. */
export function stubResizeObserver() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = () => undefined;
      unobserve = () => undefined;
      disconnect = () => undefined;
    },
  );
}
