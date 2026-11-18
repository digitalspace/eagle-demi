import { renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFollowDetails } from './use-follow-details';

afterEach(() => vi.unstubAllGlobals());

it('reveals the panel while its details load, then stops following once they have', () => {
  let resized: () => void = vi.fn();
  const disconnect = vi.fn();
  // JSDOM has no ResizeObserver; this one lets the test fire the resize.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  const panel = document.createElement('div');
  panel.innerHTML = '<section aria-busy="true"></section>';
  const ref = { current: panel };
  const reveal = vi.fn();
  const onDone = vi.fn();
  renderHook(() => useFollowDetails(ref, true, reveal, onDone));

  resized();
  expect(reveal).toHaveBeenCalledWith(panel);
  expect(disconnect).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();

  panel.firstElementChild!.setAttribute('aria-busy', 'false');
  resized();
  expect(reveal).toHaveBeenCalledTimes(2);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledOnce();
});
