import { useEffect, type RefObject } from 'react';

/**
 * Closes an open panel on Escape or on a press outside it, and puts focus back on its toggle.
 *
 * Escape is taken on the capture phase and stopped: the map screen behind an open panel clears the
 * selection on Escape, and the panel in front owns the key while it is open.
 */
export function useDismissable(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  toggleRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
      toggleRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, panelRef, toggleRef, onClose]);
}
