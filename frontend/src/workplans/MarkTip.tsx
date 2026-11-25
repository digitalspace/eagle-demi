import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router';
import { tipText, type Tip } from './chart-types';
import { TipBox, type Shown, type TipMore } from './MarkTipBox';
import './chart-controls.css';

const HIDE_DELAY_MS = 200;
/** A mark closer than this to the top of the window gets its tip below it. */
const FLIP_TOP_PX = 80;
const MAX_HALF_PX = 160;
const EDGE_PX = 16;
const GAP_PX = 8;
/** Smallest pointer target of a mark; one drawn narrower than this counts as a narrow mark. */
const MIN_HIT_PX = 24;

/** Props that make a mark a keyboard and pointer trigger for the page tooltip. */
export interface MarkBinding {
  role: 'img';
  tabIndex: 0;
  'aria-label': string;
  onMouseEnter: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (event: { currentTarget: HTMLElement }) => void;
  onBlur: () => void;
}

export interface MarkTipOptions {
  /** Mark buttons in `rootRef`, siblings per row, with `data-tip`, `-type`, `-kind`, optional `-doc`; root listeners add pinning and row keys. */
  delegate?: string;
}

export interface MarkTipControl {
  /** Goes on the positioned box the tooltip is placed in; render `tooltip` inside it. */
  rootRef: RefObject<HTMLDivElement | null>;
  /** The one `role="tooltip"` element of the page. */
  tooltip: ReactNode;
  bind: (tip: Tip) => MarkBinding;
  /** Mouse-move handler for a region of marks carrying `data-tip` text; ignores the pointer over `exclude`. */
  hitTest: (event: MouseEvent<HTMLElement>, exclude?: string) => void;
  hide: () => void;
  hideSoon: () => void;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** Reads the "Title; Label: value" text form back; a piece without ": " belongs to the one before it. */
function parseTip(text: string): Tip {
  const [title, ...pieces] = text.split('; ');
  const rows: Tip['rows'] = [];
  for (const piece of pieces) {
    const at = piece.indexOf(': ');
    if (at > 0) rows.push({ label: piece.slice(0, at), value: piece.slice(at + 2) });
    else if (rows.length) rows[rows.length - 1].value += `; ${piece}`;
  }
  return { title, rows };
}

function moreOf(el: HTMLElement, delegate: string): TipMore {
  const own = delegate.replace(/^\./, '');
  return {
    type: el.dataset.tipType ?? '',
    look: [...el.classList].filter((cls) => cls !== own).join(' '),
    pc: el.style.getPropertyValue('--pc'),
    kind: el.dataset.tipKind ?? '',
    doc: el.dataset.tipDoc ?? '',
  };
}

function place(anchor: Element, root: HTMLElement, pointerX: number | null) {
  const mark = anchor.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  const half = Math.max(0, Math.min(MAX_HALF_PX, box.width / 2 - EDGE_PX));
  const at = pointerX === null ? mark.left + mark.width / 2 : clamp(pointerX, mark.left, mark.right);
  const below = mark.top < FLIP_TOP_PX;
  return {
    x: Math.round(clamp(at - box.left, EDGE_PX + half, box.width - EDGE_PX - half)),
    y: Math.round(below ? mark.bottom - box.top + GAP_PX : mark.top - box.top - GAP_PX),
    below,
  };
}

function pointedMark(event: MouseEvent<HTMLElement>, exclude: string | undefined): HTMLElement | null {
  const { clientX: x, clientY: y } = event;
  const under = document.elementsFromPoint(x, y);
  if (exclude && under[0]?.closest(exclude)) return null;
  const hits = under.filter(
    (el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.tip && event.currentTarget.contains(el),
  );
  // A narrow mark in reach beats the wide bar under it; among narrow marks a painted one wins, then the nearest centre.
  const inside = (r: DOMRect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const away = (r: DOMRect) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
  const centre = (r: DOMRect) => Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y);
  const boxes = hits.map((el) => ({ el, r: el.getBoundingClientRect() }));
  const narrow = boxes
    .filter(({ r }) => r.width < MIN_HIT_PX)
    .sort((a, b) => Number(inside(b.r)) - Number(inside(a.r)) || centre(a.r) - centre(b.r));
  const painted = boxes.find(({ r }) => inside(r));
  return narrow[0]?.el ?? painted?.el ?? boxes.sort((a, b) => away(a.r) - away(b.r))[0]?.el ?? null;
}

/** The delegated marks of `mark`'s row, left to right, then top to bottom. */
function rowMarks(mark: HTMLElement, delegate: string): HTMLElement[] {
  const all = [...(mark.parentElement?.querySelectorAll<HTMLElement>(`:scope > ${delegate}`) ?? [])];
  return all
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .sort((a, b) => a.r.left - b.r.left || a.r.top - b.r.top)
    .map(({ el }) => el);
}

interface DelegateInput {
  rootRef: RefObject<HTMLDivElement | null>;
  tipRef: RefObject<HTMLDivElement | null>;
  now: RefObject<Shown | null>;
  quiet: RefObject<boolean>;
  toLink: RefObject<boolean>;
  delegate: string | undefined;
  show: (anchor: Element, tip: Tip, pointerX: number | null, pinned?: boolean) => void;
  hide: () => void;
}

/** Root listeners for delegated marks: focus and click show or pin the tip, Tab goes into its link, arrows walk the row. */
function useDelegatedMarks({ rootRef, tipRef, now, quiet, toLink, delegate, show, hide }: DelegateInput) {
  useEffect(() => {
    const root = rootRef.current;
    if (!delegate || !root) return;
    const markOf = (target: EventTarget | null) =>
      target instanceof Element && !tipRef.current?.contains(target) ? target.closest<HTMLElement>(delegate) : null;
    const inTip = (target: EventTarget | null) => target instanceof Node && !!tipRef.current?.contains(target);
    // Each row's tab stop before focus moved it, so Tab reaches the row on that mark again once focus leaves.
    const home = new WeakMap<Element, HTMLElement>();

    const onFocusIn = (event: FocusEvent) => {
      const mark = markOf(event.target);
      if (!mark) return;
      const row = mark.parentElement;
      if (row) {
        for (const el of row.querySelectorAll<HTMLElement>(`:scope > ${delegate}[tabindex="0"]`)) {
          if (el === mark) continue;
          if (!home.has(row)) home.set(row, el);
          el.tabIndex = -1;
        }
      }
      mark.tabIndex = 0;
      if (quiet.current || now.current?.anchor === mark) return;
      show(mark, parseTip(mark.dataset.tip ?? ''), null);
    };

    const onFocusOut = (event: FocusEvent) => {
      const to = event.relatedTarget;
      const mark = markOf(event.target);
      const row = mark?.parentElement;
      if (mark && row && !(to instanceof Node && row.contains(to))) {
        const back = home.get(row);
        if (back?.isConnected && back !== mark) {
          mark.tabIndex = -1;
          back.tabIndex = 0;
        }
        home.delete(row);
      }
      const at = now.current;
      if (!at || inTip(to) || markOf(to)) return;
      if (at.pinned ? to !== null && to !== at.anchor : mark === at.anchor) hide();
    };

    const onClick = (event: globalThis.MouseEvent) => {
      const mark = markOf(event.target);
      if (!mark) return;
      // Enter and Space fire a click with no pointer detail.
      const keyboard = event.detail === 0;
      toLink.current = keyboard && !!mark.dataset.tipDoc;
      show(mark, parseTip(mark.dataset.tip ?? ''), keyboard ? null : event.clientX, true);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Tab from a pinned tip's mark goes into its link. Out of the link, Shift+Tab stops on the mark and Tab goes on from it.
      const at = now.current;
      const link = tipRef.current?.querySelector<HTMLElement>('a[href]');
      if (event.key === 'Tab' && at?.pinned && link && at.anchor instanceof HTMLElement) {
        if (event.target === at.anchor && !event.shiftKey) {
          event.preventDefault();
          link.focus();
        } else if (event.target === link) {
          if (event.shiftKey) event.preventDefault();
          quiet.current = true;
          at.anchor.focus();
          quiet.current = false;
        }
        return;
      }
      const mark = markOf(event.target);
      if (!mark || !/^(ArrowRight|ArrowLeft|Home|End)$/.test(event.key)) return;
      event.preventDefault();
      const list = rowMarks(mark, delegate);
      const i = list.indexOf(mark);
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const j = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : clamp(i + step, 0, list.length - 1);
      const next = list[j];
      if (!next || next === mark) return;
      next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      next.focus({ preventScroll: true });
    };

    const onPress = (event: PointerEvent) => {
      if (now.current?.pinned && !inTip(event.target) && !markOf(event.target)) hide();
    };

    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [rootRef, tipRef, now, quiet, toLink, delegate, show, hide]);
}

/**
 * One hoverable tooltip per page: stays while hovered, closes 200 ms after the pointer leaves, on Escape, and when its
 * marks scroll. With `delegate` it also pins, takes keyboard focus to its link, and handles the row keys.
 */
export function useMarkTip({ delegate }: MarkTipOptions = {}): MarkTipControl {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { search } = useLocation();
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [shown, setShownState] = useState<Shown | null>(null);
  // The root listeners read the tip without re-binding on every change.
  const now = useRef<Shown | null>(null);
  const setShown = useCallback((next: Shown | null) => {
    now.current = next;
    setShownState(next);
  }, []);
  /** Set when a keyboard pin should move focus to the document link once it is drawn. */
  const toLink = useRef(false);
  /** Set while focus goes back to a mark on Escape, so that focus does not reopen the tip. */
  const quiet = useRef(false);

  const keep = useCallback(() => window.clearTimeout(timer.current), []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setShown(null);
  }, [setShown]);
  const hideSoon = useCallback(() => {
    window.clearTimeout(timer.current);
    if (now.current?.pinned) return;
    timer.current = window.setTimeout(() => setShown(null), HIDE_DELAY_MS);
  }, [setShown]);

  const show = useCallback(
    (anchor: Element, tip: Tip, pointerX: number | null, pinned = false) => {
      keep();
      const root = rootRef.current;
      const more = delegate && anchor instanceof HTMLElement ? moreOf(anchor, delegate) : null;
      if (root) setShown({ tip, more, anchor, pinned, ...place(anchor, root, pointerX) });
    },
    [keep, delegate, setShown],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Marks the element the tip belongs to, for its outline.
  const anchor = shown?.anchor ?? null;
  useEffect(() => {
    if (!anchor) return;
    anchor.setAttribute('data-tip-on', '');
    return () => anchor.removeAttribute('data-tip-on');
  }, [anchor]);

  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const back = delegate && tipRef.current?.contains(document.activeElement) ? shown.anchor : null;
      hide();
      if (back instanceof HTMLElement) {
        quiet.current = true;
        back.focus();
        quiet.current = false;
      }
    };
    // Scrolling the box that holds the mark moves it away from the tip; scrolling the whole page moves both.
    const onScroll = (event: Event) => {
      const box = event.target;
      if (!(box instanceof Node && box.contains(shown.anchor) && !box.contains(rootRef.current))) return;
      // Arrow keys scroll the next mark into view; its tip follows it rather than closing.
      const root = rootRef.current;
      if (delegate && root && !shown.pinned && shown.anchor === document.activeElement) setShown({ ...shown, ...place(shown.anchor, root, null) });
      else hide();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [shown, hide, delegate, setShown]);

  useEffect(() => {
    if (!shown?.pinned || !toLink.current) return;
    toLink.current = false;
    tipRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
  }, [shown]);

  useDelegatedMarks({ rootRef, tipRef, now, quiet, toLink, delegate, show, hide });

  const bind = (tip: Tip): MarkBinding => ({
    role: 'img',
    tabIndex: 0,
    'aria-label': tipText(tip),
    onMouseEnter: (event) => show(event.currentTarget, tip, event.clientX),
    onMouseLeave: hideSoon,
    onFocus: (event) => show(event.currentTarget, tip, null),
    onBlur: hide,
  });

  const hitTest = (event: MouseEvent<HTMLElement>, exclude?: string) => {
    if (shown?.pinned) return;
    // A link over the marks, such as a jump link, is not a mark.
    const mark = pointedMark(event, delegate ? [exclude, 'a'].filter(Boolean).join(', ') : exclude);
    if (!mark) hideSoon();
    else if (mark === shown?.anchor) keep();
    else show(mark, parseTip(mark.dataset.tip ?? ''), null);
  };

  const tooltip = <TipBox shown={shown} tipRef={tipRef} search={search} keep={keep} hideSoon={hideSoon} />;

  return { rootRef, tooltip, bind, hitTest, hide, hideSoon };
}
