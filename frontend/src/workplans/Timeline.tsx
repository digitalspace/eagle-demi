import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Link } from 'react-router';
import { WorkPill } from '../screens/SheetWorksPanel';
import { toneOf, type WorkRow } from './derive';
import type { ViewProps } from './Filters';
import { Segmented } from './Segmented';
import { useFollowDetails } from './use-follow-details';
import { hasDetails, projectDetailsPath } from './work-notes';
import { DetailsToggle, WorkDetails } from './WorkDetails';
import { daysOf, GROUP_BYS, groupsOf, summaryOf, workTypeOf, type Group, type GroupBy } from './timeline-rows';
import {
  dayNumber,
  drawsSuspension,
  extentOf,
  scaleFor,
  scrollFor,
  spansOf,
  tagDayOf,
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
/** Narrowest bar that keeps its phase name; a few letters and an ellipsis say nothing. */
const MIN_LABEL_PX = 56;

function Legend({ suspension }: { suspension: boolean }) {
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
        <span className="timeline__swatch timeline__bar--incomplete" aria-hidden="true" />
        Not completed
      </li>
      <li>
        <span className="timeline__swatch timeline__bar--upcoming" aria-hidden="true" />
        Planned
      </li>
      <li>
        <span className="timeline__swatch timeline__bar--overrun" aria-hidden="true" />
        Overdue
      </li>
      {suspension && (
        <li>
          <span className="timeline__swatch timeline__bar--suspended" aria-hidden="true" />
          Suspended
        </li>
      )}
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

/** The sticky columns: work title with its Details toggle, work type, days in phase. */
function RowLeft({ row, details }: { row: WorkRow; details?: { id: string; open: boolean; toggle: () => void } }) {
  const type = workTypeOf(row);
  const title = row.work.title || 'Untitled work';
  return (
    <div className="timeline__left">
      <span className="timeline__work">
        <Link className="timeline__name" to={projectDetailsPath(row.work.projectId)} title={title}>
          {title}
        </Link>
        {/* WorkPill takes no title; its own text is the tooltip once CSS cuts it short. */}
        <span
          className="timeline__flag"
          ref={(el) => {
            if (el) el.title = el.textContent ?? '';
          }}
        >
          <WorkPill work={row.work} />
        </span>
        {details && (
          <DetailsToggle
            className="timeline__toggle"
            title={title}
            controls={details.id}
            open={details.open}
            onToggle={details.toggle}
          />
        )}
      </span>
      <abbr className="timeline__type" title={type.name}>
        {type.code}
      </abbr>
      <span className={`timeline__days${row.overdue ? ' timeline__days--over' : ''}`} aria-hidden="true">
        {daysOf(row)}
      </span>
    </div>
  );
}

/** Scrolls an open panel into view, never so far that its row goes under the head. */
function reveal(panel: HTMLElement) {
  const box = panel.closest<HTMLElement>('.timeline__scroll');
  const head = box?.querySelector<HTMLElement>('.timeline__head');
  const row = panel.closest('li')?.previousElementSibling;
  if (!box || !head || !row) return;
  const top = box.getBoundingClientRect().top + box.clientTop;
  const below = panel.getBoundingClientRect().bottom - (top + box.clientHeight);
  const room = row.getBoundingClientRect().top - top - head.offsetHeight;
  if (below > 0 && room > 0) box.scrollTop += Math.min(below, room);
}

const keyOf = (row: WorkRow) => `${row.work.source}-${row.work.workId}`;

/** Rows with their details open; `follow` is the one last opened, scrolled along until its details load. */
interface Opened {
  open: ReadonlySet<string>;
  follow: string | null;
}

interface RowProps {
  row: WorkRow;
  scale: Scale;
  today: string;
  open: boolean;
  follow: boolean;
  toggle: (key: string) => void;
  unfollow: () => void;
}

const TimelineRow = memo(function TimelineRow({ row, scale, today, open, follow, toggle, unfollow }: RowProps) {
  const detailsId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useFollowDetails(panelRef, open && follow, reveal, unfollow);
  const spans = spansOf(row, today);
  const tone = toneOf(row);
  const tagX = xOf(scale, tagDayOf(spans, today)) + 4;
  const details = hasDetails(row) ? { id: detailsId, open, toggle: () => toggle(keyOf(row)) } : undefined;
  return (
    <>
      <li className="timeline__row">
        <RowLeft row={row} details={details} />
        <div className="timeline__lane" aria-hidden="true">
          {spans.map((span, i) => {
            const left = xOf(scale, dayNumber(span.start));
            const width = Math.max(2, xOf(scale, dayNumber(span.end)) - left);
            const current = span.kind === 'current';
            const label = current && width >= MIN_LABEL_PX && span.name;
            return (
              <span
                key={i}
                className={`timeline__bar timeline__bar--${span.kind}${current ? ` timeline__bar--${tone}` : ''}`}
                style={{ left, width }}
              >
                {label && <span className="timeline__label">{label}</span>}
              </span>
            );
          })}
          {!spans.length && <span className="timeline__undated">No dated phases</span>}
          {row.suspended && (
            <span
              className="timeline__note"
              // Slides back left by however much it would run past the lane end.
              style={{
                left: tagX,
                translate: `min(0px, calc(${scale.width - tagX}px - 100%))`,
              }}
            >
              Suspended{row.suspendedUnder ? ` ${row.suspendedUnder}` : ''}
            </span>
          )}
        </div>
        <span className="visually-hidden">{summaryOf(row)}</span>
      </li>
      {open && (
        <li className="timeline__detail">
          <div className="timeline__detail-body" ref={panelRef}>
            <WorkDetails row={row} id={detailsId} />
          </div>
        </li>
      )}
    </>
  );
});

function TimelineGroup({
  group,
  open,
  onToggle,
  scale,
  today,
  opened,
  onDetails,
  unfollow,
}: {
  group: Group;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
  scale: Scale;
  today: string;
  opened: Opened;
  onDetails: (key: string) => void;
  unfollow: () => void;
}) {
  const count = group.rows.length;
  return (
    <details className="timeline__group" open={open} onToggle={(event) => onToggle(group.key, event.currentTarget.open)}>
      <summary className="timeline__group-head">
        <span className="timeline__group-label">
          <span className="timeline__group-name">{group.label}</span>
          <span className="timeline__group-meta">
            <span className="timeline__group-count">
              {count} {count === 1 ? 'work' : 'works'}
            </span>
            {group.overdue > 0 && <span className="pill pill--danger timeline__pill">{group.overdue} overdue</span>}
          </span>
        </span>
      </summary>
      {open && (
        <ul className="timeline__rows">
          {group.rows.map((row) => (
            <TimelineRow
              key={keyOf(row)}
              row={row}
              scale={scale}
              today={today}
              open={opened.open.has(keyOf(row))}
              follow={opened.follow === keyOf(row)}
              toggle={onDetails}
              unfollow={unfollow}
            />
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
export function TimelineView({ rows, today, bar }: ViewProps) {
  const [zoom, setZoom] = useState<Zoom>('quarter');
  const [groupBy, setGroupBy] = useState<GroupBy>('act');
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
  const groups = useMemo(() => groupsOf(rows, groupBy), [rows, groupBy]);
  const suspension = useMemo(() => drawsSuspension(rows, today), [rows, today]);
  // A followed row hidden before its details load would jump the page when shown again.
  const { follow } = opened;
  if (follow && !groups.some((group) => !closed.has(group.key) && group.rows.some((row) => keyOf(row) === follow))) {
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
  const goToToday = () => {
    if (zoom === 'fit') changeZoom('quarter');
    else if (scroller.current) scroller.current.scrollLeft = scrollFor(scale, dayNumber(today), lanePx);
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
          <Segmented label="Zoom" options={ZOOMS} value={zoom} onChange={changeZoom} />
          <button type="button" className="timeline__today" onClick={goToToday}>
            Today
          </button>
          <Segmented label="Group by" options={GROUP_BYS} value={groupBy} onChange={setGroupBy} />
          <Legend suspension={suspension} />
        </div>
        {rows.length ? (
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
                  <span className="timeline__days-head" title="Days in phase">
                    Days
                  </span>
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
        ) : (
          <p className="timeline__empty">No works match these filters. Clear a filter to see more.</p>
        )}
      </section>
    </>
  );
}
