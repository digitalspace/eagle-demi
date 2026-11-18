import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { ChipSelect } from './ChipSelect';
import { rowKey } from './derive';
import type { ViewProps } from './Filters';
import { Segmented } from './Segmented';
import { Axis, Legend } from './timeline-parts';
import { GROUP_BYS, groupsOf, SORTS, type GroupBy, type SortBy } from './timeline-rows';
import { dayNumber, drawnKinds, extentOf, scaleFor, scrollFor, xOf, ZOOMS, type Zoom } from './timeline-scale';
import { TimelineOverview } from './TimelineOverview';
import { TimelineGroup, type Opened } from './TimelineRow';
import './timeline.css';

/** Lane width before the first measure, and in JSDOM where nothing has a size. */
const FALLBACK_LANE_PX = 960;
const MIN_LANE_PX = 240;

/** Lane viewport width: the scroll box less the sticky left columns, kept current on resize; null until measured. */
function useLaneWidth(scroller: RefObject<HTMLDivElement | null>, left: RefObject<HTMLDivElement | null>, shown: boolean) {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const measure = () => {
      const lane = box.clientWidth - (left.current?.offsetWidth ?? 0);
      setWidth(lane > 0 ? Math.max(MIN_LANE_PX, lane) : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [scroller, left, shown]);
  return width;
}

/** Gantt of every work in `rows`, grouped, on a zoomable axis that scrolls inside its own panel. */
export function TimelineView({ rows, today, bar }: ViewProps) {
  const [zoom, setZoom] = useState<Zoom>('quarter');
  const [groupBy, setGroupBy] = useState<GroupBy>('act');
  const [sort, setSort] = useState<SortBy>('start');
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  // Held here, not per row, so open details survive a group folding or a Group by change.
  const [opened, setOpened] = useState<Opened>({ open: new Set(), follow: null });
  const toggleDetails = useCallback(
    (key: string) =>
      setOpened(({ open, follow }) => {
        const next = new Set(open);
        if (!next.delete(key)) next.add(key);
        return { open: next, follow: next.has(key) ? key : follow === key ? null : follow };
      }),
    [],
  );
  const unfollow = useCallback(() => setOpened((prev) => (prev.follow === null ? prev : { ...prev, follow: null })), []);
  const scroller = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  // Set when the next layout should scroll today into view: first render, Today, and every zoom change.
  const toToday = useRef(true);
  const measured = useLaneWidth(scroller, left, rows.length > 0);
  const lanePx = measured ?? FALLBACK_LANE_PX;

  const extent = useMemo(() => extentOf(rows, today), [rows, today]);
  const scale = useMemo(() => scaleFor(extent, zoom, today, lanePx), [extent, zoom, today, lanePx]);
  const groups = useMemo(() => groupsOf(rows, groupBy, sort), [rows, groupBy, sort]);
  const drawn = useMemo(() => drawnKinds(rows, today), [rows, today]);
  // A followed row hidden before its details load would jump the page when shown again.
  const { follow } = opened;
  if (follow && !groups.some((group) => !closed.has(group.key) && group.rows.some((row) => rowKey(row) === follow))) {
    unfollow();
  }

  // Waits for a measured width, else the first scroll lands on the fallback scale and drifts.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !toToday.current || measured === null) return;
    box.scrollLeft = scrollFor(scale, dayNumber(today), lanePx);
    toToday.current = false;
  }, [scale, lanePx, measured, today]);

  const changeZoom = (next: Zoom) => {
    toToday.current = true;
    setZoom(next);
  };
  const pan = (px: number) => {
    if (scroller.current) scroller.current.scrollLeft = px;
  };
  const goToToday = () => {
    if (zoom === 'fit') changeZoom('quarter');
    else pan(scrollFor(scale, dayNumber(today), lanePx));
  };
  const toggle = (key: string, open: boolean) =>
    setClosed((prev) => {
      if (prev.has(key) === !open) return prev;
      const next = new Set(prev);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      {bar?.()}
      <section className="panel timeline" aria-label="Timeline">
        <div className="timeline__toolbar">
          <Segmented label="Zoom" labelHidden options={ZOOMS} value={zoom} onChange={changeZoom} />
          <button type="button" className="wp-chip wp-chip--accent" onClick={goToToday}>
            Today
          </button>
          <ChipSelect label="Group by" options={GROUP_BYS} value={groupBy} onChange={(v) => v && setGroupBy(v)} />
          <ChipSelect label="Sort" options={SORTS} value={sort} onChange={(v) => v && setSort(v)} />
          <Legend drawn={drawn} />
        </div>
        {rows.length ? (
          <>
            <div className="timeline__scroll" ref={scroller}>
              <div className="timeline__canvas" style={{ '--timeline-lane': `${scale.width}px` } as CSSProperties}>
                {/* First in the canvas, so bar labels and the suspended tag, on the same layer, paint over it. */}
                <span
                  className="timeline__today-line"
                  style={{ left: `calc(var(--timeline-left) + ${xOf(scale, dayNumber(today))}px)` }}
                  aria-hidden="true"
                />
                <div className="timeline__head" aria-hidden="true">
                  <div className="timeline__left timeline__left--head" ref={left}>
                    <span>Work</span>
                    <span className="timeline__type-head">Type</span>
                    <span className="timeline__days-head">Days in phase</span>
                  </div>
                  <Axis scale={scale} />
                </div>
                {groups.map((group) => (
                  <TimelineGroup
                    key={group.key}
                    group={group}
                    open={!closed.has(group.key)}
                    onToggle={toggle}
                    scale={scale}
                    today={today}
                    opened={opened}
                    onDetails={toggleDetails}
                    unfollow={unfollow}
                  />
                ))}
              </div>
            </div>
            {zoom !== 'fit' && (
              <TimelineOverview
                rows={rows}
                scale={scale}
                lanePx={lanePx}
                today={today}
                scroller={scroller}
                onPan={pan}
              />
            )}
          </>
        ) : (
          <p className="timeline__empty">No works match these filters. Clear a filter to see more.</p>
        )}
      </section>
    </>
  );
}
