import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Link } from 'react-router';
import { WorkPill } from '../screens/SheetWorksPanel';
import { toneOf, type WorkRow } from './derive';
import { Segmented } from './Segmented';
import { daysOf, GROUP_BYS, groupsOf, summaryOf, workTypeOf, type Group, type GroupBy } from './timeline-rows';
import {
  dayNumber,
  extentOf,
  scaleFor,
  scrollFor,
  spansOf,
  ticksFor,
  xOf,
  ZOOMS,
  type Scale,
  type Zoom,
} from './timeline-scale';
import './timeline.css';

/** Lane width before the first measure, and in JSDOM where nothing has a size. */
const FALLBACK_LANE_PX = 960;
const MIN_LANE_PX = 240;

function Legend() {
  return (
    <ul className="timeline__legend" aria-label="Legend">
      <li>
        <span className="timeline__swatch timeline__bar--past" aria-hidden="true" />
        Done
      </li>
      <li>
        <span className="timeline__swatch timeline__bar--current timeline__bar--review" aria-hidden="true" />
        Current phase, named
      </li>
      <li>
        <span className="timeline__swatch timeline__bar--upcoming" aria-hidden="true" />
        Planned
      </li>
      <li>
        <span className="timeline__swatch timeline__bar--overrun" aria-hidden="true" />
        Overdue
      </li>
      <li>
        <span className="timeline__swatch timeline__bar--suspended" aria-hidden="true" />
        Suspended
      </li>
      <li>
        <span className="timeline__swatch timeline__swatch--today" aria-hidden="true" />
        Today
      </li>
    </ul>
  );
}

function Axis({ scale }: { scale: Scale }) {
  const { top, bottom } = ticksFor(scale);
  return (
    <div className="timeline__axis">
      {[top, bottom].map((ticks, tier) => (
        <div key={tier} className={`timeline__tier timeline__tier--${tier ? 'bottom' : 'top'}`}>
          {ticks.map((tick) => (
            <span key={tick.x} className="timeline__tick" style={{ left: tick.x, width: tick.width }}>
              {tick.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

const TimelineRow = memo(function TimelineRow({ row, scale, today }: { row: WorkRow; scale: Scale; today: string }) {
  const type = workTypeOf(row);
  const spans = spansOf(row, today);
  const tone = toneOf(row);
  const title = row.work.title || 'Untitled work';
  return (
    <li className="timeline__row">
      <div className="timeline__left">
        <span className="timeline__work">
          <Link className="timeline__name" to={`/project-details/${encodeURIComponent(row.work.projectId)}`} title={title}>
            {title}
          </Link>
          <WorkPill work={row.work} />
        </span>
        <abbr className="timeline__type" title={type.name}>
          {type.code}
        </abbr>
        <span className={`timeline__days${row.overdue ? ' timeline__days--over' : ''}`} aria-hidden="true">
          {daysOf(row)}
        </span>
      </div>
      <div className="timeline__lane" aria-hidden="true">
        {spans.map((span, i) => {
          const left = xOf(scale, dayNumber(span.start));
          const width = Math.max(2, xOf(scale, dayNumber(span.end)) - left);
          const current = span.kind === 'current';
          return (
            <span
              key={i}
              className={`timeline__bar timeline__bar--${span.kind}${current ? ` timeline__bar--${tone}` : ''}`}
              style={{ left, width }}
            >
              {current && span.name}
            </span>
          );
        })}
        {!spans.length && <span className="timeline__undated">No dated phases</span>}
        {row.suspended && (
          <span className="timeline__note" style={{ left: xOf(scale, dayNumber(today)) + 6 }}>
            Suspended{row.suspendedUnder ? ` ${row.suspendedUnder}` : ''}
          </span>
        )}
      </div>
      <span className="visually-hidden">{summaryOf(row)}</span>
    </li>
  );
});

function TimelineGroup({
  group,
  open,
  onToggle,
  scale,
  today,
}: {
  group: Group;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
  scale: Scale;
  today: string;
}) {
  const count = group.rows.length;
  return (
    <details className="timeline__group" open={open} onToggle={(event) => onToggle(group.key, event.currentTarget.open)}>
      <summary className="timeline__group-head">
        <span className="timeline__group-label">
          <span className="timeline__group-name">{group.label}</span>
          <span className="timeline__group-count">
            {count} {count === 1 ? 'work' : 'works'}
          </span>
          {group.overdue > 0 && <span className="pill pill--danger timeline__pill">{group.overdue} overdue</span>}
        </span>
      </summary>
      {open && (
        <ul className="timeline__rows">
          {group.rows.map((row) => (
            <TimelineRow key={`${row.work.source}-${row.work.workId}`} row={row} scale={scale} today={today} />
          ))}
        </ul>
      )}
    </details>
  );
}

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
export function TimelineView({ rows, today }: { rows: WorkRow[]; today: string }) {
  const [zoom, setZoom] = useState<Zoom>('quarter');
  const [groupBy, setGroupBy] = useState<GroupBy>('act');
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  // Day to bring into view, and where in the viewport, after the next layout.
  const anchor = useRef<{ day: number; at: number } | null>({ day: dayNumber(today), at: 0.25 });
  const measured = useLaneWidth(scroller, left, rows.length > 0);
  const lanePx = measured ?? FALLBACK_LANE_PX;

  const extent = useMemo(() => extentOf(rows, today), [rows, today]);
  const scale = useMemo(() => scaleFor(extent, zoom, today, lanePx), [extent, zoom, today, lanePx]);
  const groups = useMemo(() => groupsOf(rows, groupBy), [rows, groupBy]);

  // Waits for a measured width, else the first scroll lands on the fallback scale and drifts.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !anchor.current || measured === null) return;
    box.scrollLeft = scrollFor(scale, anchor.current.day, lanePx, anchor.current.at);
    anchor.current = null;
  }, [scale, lanePx, measured]);

  const changeZoom = (next: Zoom) => {
    const box = scroller.current;
    const centre = box ? scale.start + (box.scrollLeft + lanePx / 2) / scale.pxPerDay : dayNumber(today);
    anchor.current = { day: centre, at: 0.5 };
    setZoom(next);
  };
  const goToToday = () => {
    anchor.current = { day: dayNumber(today), at: 0.25 };
    if (zoom === 'fit') setZoom('quarter');
    else if (scroller.current) scroller.current.scrollLeft = scrollFor(scale, anchor.current.day, lanePx, 0.25);
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
    <section className="panel timeline" aria-label="Timeline">
      <div className="timeline__toolbar">
        <Segmented label="Zoom" options={ZOOMS} value={zoom} onChange={changeZoom} />
        <button type="button" className="timeline__today" onClick={goToToday}>
          Today
        </button>
        <Segmented label="Group by" options={GROUP_BYS} value={groupBy} onChange={setGroupBy} />
        <Legend />
      </div>
      {rows.length ? (
        <div className="timeline__scroll" ref={scroller}>
          <div className="timeline__canvas" style={{ '--timeline-lane': `${scale.width}px` } as CSSProperties}>
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
              />
            ))}
            <span
              className="timeline__today-line"
              style={{ left: `calc(var(--timeline-left) + ${xOf(scale, dayNumber(today))}px)` }}
              aria-hidden="true"
            />
          </div>
        </div>
      ) : (
        <p className="timeline__empty">No works match these filters. Clear a filter to see more.</p>
      )}
    </section>
  );
}
