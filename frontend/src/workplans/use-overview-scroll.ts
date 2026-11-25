import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ActYear } from './chart-facts';
import { plotAt, plotPx } from './overview-plot';
import type { OverviewActData } from './use-overview-acts';

/** Px of each Act's rows box left of the track: the sticky name column and its gutter. */
export const NAME_INSET_PX = 368;
/** Rows box border, for the estimate from the root before any box is drawn. */
const BOX_BORDER_PX = 2;
/** Visible track width before the first measure. */
const FIRST_TRACK_PX = 1006;
const RESIZE_SETTLE_MS = 150;

/** Where to scroll each Act's timeline box; `centre` holds each Act's centre as a fraction of its axis. */
export type ScrollTo =
  | { to: 'open' }
  | { to: 'today' }
  | { to: 'year'; year: number }
  | { to: 'centre'; at: Partial<Record<ActYear, number>> };

function leftFor(how: ScrollTo, act: OverviewActData, box: HTMLElement): number | null {
  const track = box.scrollWidth - NAME_INSET_PX;
  const vis = box.clientWidth - NAME_INSET_PX;
  const { axis, todayAt } = act;
  if (how.to === 'centre') {
    const at = how.at[act.year];
    return at === undefined ? null : plotPx(at, track) - vis / 2;
  }
  if (how.to === 'year') return axis ? plotPx((Date.UTC(how.year, 0, 1) - axis.a0) / (axis.a1 - axis.a0), track) - vis / 3 : null;
  // "open": today at two thirds of the window for an Act with work in progress, else its latest date.
  if (todayAt !== null && (how.to === 'today' || act.live)) return plotPx(todayAt, track) - (vis * 2) / 3;
  if (how.to === 'today') return box.scrollWidth;
  const his = act.rows.flatMap((row) => row.drawing.hi ?? []);
  return his.length ? plotPx(Math.max(...his), track) - vis * 0.85 : null;
}

/**
 * Each Act's rows box registers here. The hook measures the visible track width (the first box, else the
 * Overview root) and scrolls the boxes for zoom, Today and the year select.
 */
export function useOverviewScroll(rootRef: RefObject<HTMLElement | null>) {
  const boxes = useRef(new Map<ActYear, HTMLElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const [trackPx, setTrackPx] = useState(FIRST_TRACK_PX);

  const measure = useCallback(() => {
    const box = [...boxes.current.values()][0];
    const width = box ? box.clientWidth - NAME_INSET_PX : (rootRef.current?.clientWidth ?? 0) - BOX_BORDER_PX - NAME_INSET_PX;
    if (width > 0) setTrackPx(Math.round(width));
  }, [rootRef]);

  useEffect(() => {
    // Each new width redraws every row, so a window drag measures once it stops.
    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, RESIZE_SETTLE_MS);
    });
    observer.current = ro;
    if (rootRef.current) ro.observe(rootRef.current);
    boxes.current.forEach((box) => ro.observe(box));
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
      observer.current = null;
    };
  }, [measure, rootRef]);

  /** Ref callback for an Act's rows box; null when the Act closes or unmounts. */
  const register = useCallback(
    (year: ActYear, box: HTMLElement | null) => {
      const old = boxes.current.get(year);
      if (old === box) return;
      if (old) observer.current?.unobserve(old);
      if (box) {
        boxes.current.set(year, box);
        observer.current?.observe(box);
      } else boxes.current.delete(year);
      measure();
    },
    [measure],
  );

  /** Each open Act's centre as a fraction of its axis, to keep it across a zoom. */
  const centres = useCallback(() => {
    const at: Partial<Record<ActYear, number>> = {};
    boxes.current.forEach((box, year) => {
      const track = box.scrollWidth - NAME_INSET_PX;
      if (track > 0) at[year] = plotAt(box.scrollLeft + (box.clientWidth - NAME_INSET_PX) / 2, track);
    });
    return at;
  }, []);

  /** The axis box follows through the rows box's own scroll handler. */
  const scroll = useCallback((how: ScrollTo, acts: readonly OverviewActData[], only?: ActYear) => {
    for (const act of acts) {
      const box = boxes.current.get(act.year);
      if (!box || (only && act.year !== only)) continue;
      const left = leftFor(how, act, box);
      if (left !== null) box.scrollLeft = left;
    }
  }, []);

  return { trackPx, register, centres, scroll };
}
