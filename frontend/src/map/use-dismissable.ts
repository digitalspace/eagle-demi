import { useEffect, useRef, type RefObject } from 'react';

/** Escape layers open now, oldest first. Escape goes to the last one only. */
const escapeLayers: object[] = [];

/** Clicks that land on these still act after closing a panel: the reader pressed a control. */
const CONTROLS = 'a[href], button, input, select, textarea, label, summary';

/**
 * Eats the click that ends a press which closed a panel, so it never reaches what sat behind the
 * panel (the map). A press that ends without a click drops it on the next press.
 */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    done();
    if ((event.target as Element | null)?.closest?.(CONTROLS)) return;
    event.stopPropagation();
    event.preventDefault();
  };
  const done = () => {
    document.removeEventListener('click', swallow, true);
    document.removeEventListener('pointerdown', done, true);
  };
  document.addEventListener('click', swallow, true);
  document.addEventListener('pointerdown', done, true);
}

/**
 * Joins the shared Escape stack while `active`. Of every layer open, only the one opened last gets
 * Escape, and the key stops there, so the frontmost overlay closes first whatever order they opened
 * in. Use it for any overlay that closes on Escape (a dialog, a menu).
 *
 * The key is taken on the capture phase and stopped: the map screen behind an open layer clears its
 * own state on Escape. Escape that ends an IME composition is left alone. `onEscape` may change on
 * every render; only `active` moves the layer in the stack.
 */
export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    const self = {};
    escapeLayers.push(self);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || escapeLayers.at(-1) !== self) return;
      event.stopImmediatePropagation();
      latest.current();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      escapeLayers.splice(escapeLayers.indexOf(self), 1);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [active]);
}

export interface DismissableOptions {
  /**
   * Also eat the click that ends a press which closed the panel, so it never reaches what sat
   * behind it. On for panels over the map, where that click would select or clear a project. Off by
   * default: over a list or grid the press should still land on the row.
   */
  swallowClosingClick?: boolean;
}

/**
 * Closes an open panel on Escape (as a `useEscapeLayer` layer) or on a press outside it. Escape
 * hands focus back to the toggle when focus was inside the panel. `onClose` must be stable: a new
 * function re-arms the outside-press listener.
 */
export function useDismissable(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  toggleRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  { swallowClosingClick = false }: DismissableOptions = {},
): void {
  useEscapeLayer(open, () => {
    const focusInside = panelRef.current?.contains(document.activeElement) ?? false;
    onClose();
    if (focusInside) toggleRef.current?.focus();
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      onClose();
      if (swallowClosingClick) swallowNextClick();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, panelRef, onClose, swallowClosingClick]);
}
