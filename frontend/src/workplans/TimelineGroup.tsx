import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { rowKey, type WorkRow } from './derive';
import { plural } from './format';
import { activeByQuarter } from './timeline-activity';
import { Axis } from './timeline-parts';
import { holdsOpenWork, railOf, spanOf, yearsOf, type Group } from './timeline-rows';
import { dayNumber, holdsDay, scaleFor, scrollFor, xOf, type Extent, type Zoom } from './timeline-scale';
import { TimelineOverview } from './TimelineOverview';
import { TimelineRow, type Opened } from './TimelineRow';
import { workStateOf } from './work-state';
import './timeline-group.css';

/** Lane width before the first measure, and in JSDOM where nothing has a size. */
const FALLBACK_LANE_PX = 960;
const MIN_LANE_PX = 240;

/** Lane viewport width: the scroll box less the sticky left columns, kept current on resize; null until measured. */
function useLaneWidth(scroller: RefObject<HTMLDivElement | null>, left: RefObject<HTMLDivElement | null>) {
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
  }, [scroller, left]);
  return width;
}

/** Share of `span` from its start to `day`, as a CSS percentage. */
const pctOf = (span: Extent, day: number) => `${((day - span.start) / Math.max(1, span.end - span.start)) * 100}%`;

/**
 * The group head's one-line strip on the group's own span: each work's rail while folded, quarter cells shaded by how
 * many works are active while open.
 */
function HeadStrip({ rows, span, open, today, live }: { rows: WorkRow[]; span: Extent; open: boolean; today: string; live: boolean }) {
  const cells = useMemo(() => (open ? activeByQuarter(rows, span, today) : []), [open, rows, span, today]);
  const rails = useMemo(
    () => (open ? [] : rows.flatMap((row) => { const rail = railOf(row, today); return rail ? [{ row, rail }] : []; })),
    [open, rows, today],
  );
  const now = dayNumber(today);
  const width = (from: number, to: number) => `max(3px, ${pctOf(span, to)} - ${pctOf(span, from)})`;
  return (
    <span className="timeline__strip" aria-hidden="true">
      {cells.map((cell) => (
        <span
          key={cell.start}
          className="timeline__heat"
          title={`${cell.label}: ${plural(cell.count, 'active work')}`}
          style={{
            left: pctOf(span, cell.start),
            width: `calc(${width(cell.start, cell.end)})`,
            '--heat': `${Math.round(8 + (80 * cell.count) / rows.length)}%`,
          } as CSSProperties}
        />
      ))}
      {rails.map(({ row, rail }) => (
        <span
          key={rowKey(row)}
          className={`timeline__strip-work${workStateOf(row) === 'closed' ? '' : ' timeline__strip-work--open'}`}
          style={{ left: pctOf(span, rail.start), width: `calc(${width(rail.start, rail.end)})` }}
        />
      ))}
      {live && now >= span.start && now <= span.end && <span className="timeline__strip-today" style={{ left: pctOf(span, now) }} />}
    </span>
  );
}

export interface GroupProps {
  group: Group;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
  zoom: Zoom;
  today: string;
  opened: Opened;
  onDetails: (key: string) => void;
  unfollow: () => void;
  onJump: (key: string) => void;
  /** Both parts of each work that switched Act, by `rowKey`. */
  pairs: ReadonlyMap<string, string>;
  /** Bumped by the panel's Today button; each change scrolls today into view again. */
  toToday: number;
}

/** A little room past each end, so a mark on the first or last day is drawn whole at Fit all. */
const padded = (span: Extent | null): Extent | null => {
  if (!span) return null;
  const pad = Math.max(7, Math.round((span.end - span.start) / 100));
  return { start: span.start - pad, end: span.end + pad };
};

type BodyProps = Omit<GroupProps, 'open' | 'onToggle'> & { span: Extent | null; live: boolean };

/** The open group: its own scroller, scale, axis, today line, rows and overview. */
function GroupBody({ group, span, live, zoom, today, toToday, opened, onDetails, unfollow, onJump, pairs }: BodyProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const measured = useLaneWidth(scroller, left);
  const lanePx = measured ?? FALLBACK_LANE_PX;
  const scale = useMemo(() => scaleFor(padded(span), zoom, today, lanePx, { includeToday: live }), [span, zoom, today, lanePx, live]);
  const now = dayNumber(today);
  // The zoom and Today press last placed for; a resize alone leaves the scroll where the reader put it.
  const placed = useRef<string | null>(null);
  // Waits for a measured width, else the first scroll lands on the fallback scale and drifts.
  useLayoutEffect(() => {
    const box = scroller.current;
    const want = `${zoom}:${toToday}`;
    if (!box || measured === null || placed.current === want) return;
    placed.current = want;
    box.scrollLeft = live ? scrollFor(scale, now, lanePx) : 0;
  }, [zoom, toToday, scale, lanePx, measured, live, now]);

  return (
    <>
      <div className="timeline__scroll" ref={scroller}>
        <div className="timeline__canvas" style={{ '--timeline-lane': `${scale.width}px` } as CSSProperties}>
          {/* First in the canvas, so bar labels and the suspended tag, on the same layer, paint over it. */}
          {live && holdsDay(scale, now) && (
            <span
              className="timeline__today-line"
              style={{ left: `calc(var(--timeline-left) + ${xOf(scale, now)}px)` }}
              aria-hidden="true"
            />
          )}
          <div className="timeline__head" aria-hidden="true">
            <div className="timeline__left timeline__left--head" ref={left}>
              <span>Work</span>
              <span className="timeline__type-head">Type</span>
              <span className="timeline__days-head">Days in phase</span>
            </div>
            <Axis scale={scale} />
          </div>
          <ul className="timeline__rows">
            {group.rows.map((row) => {
              const key = rowKey(row);
              return (
                <TimelineRow
                  key={key}
                  row={row}
                  scale={scale}
                  today={today}
                  open={opened.open.has(key)}
                  follow={opened.follow === key}
                  toggle={onDetails}
                  unfollow={unfollow}
                  partner={pairs.get(key)}
                  onJump={onJump}
                />
              );
            })}
          </ul>
        </div>
      </div>
      {zoom !== 'fit' && scale.width > lanePx && (
        <TimelineOverview
          rows={group.rows}
          scale={scale}
          lanePx={lanePx}
          today={today}
          scroller={scroller}
          onPan={(px) => {
            if (scroller.current) scroller.current.scrollLeft = px;
          }}
        />
      )}
    </>
  );
}

/** One group of an Act panel as its own small timeline; folded, it mounts only its head and strip. */
export function TimelineGroup({ open, onToggle, ...props }: GroupProps) {
  const { group, today } = props;
  const span = useMemo(() => spanOf(group.rows, today), [group.rows, today]);
  const live = useMemo(() => holdsOpenWork(group.rows), [group.rows]);
  return (
    <details
      className="timeline__group"
      open={open}
      // Only a reader's toggle differs from `open`; React setting the attribute fires the event too.
      onToggle={(event) => event.currentTarget.open !== open && onToggle(group.key, event.currentTarget.open)}
    >
      <summary className="timeline__group-head">
        <span className="timeline__group-label">
          <span className="timeline__group-name">{group.label}</span>
          <span className="timeline__group-meta">
            {span && <span className="timeline__group-count">{yearsOf(span)}</span>}
            <span className="timeline__group-count">{plural(group.rows.length, 'work')}</span>
            {group.overdue > 0 && <span className="timeline__pill">{group.overdue} overdue</span>}
          </span>
        </span>
        {span && <HeadStrip rows={group.rows} span={span} open={open} today={today} live={live} />}
      </summary>
      {open && <GroupBody {...props} span={span} live={live} />}
    </details>
  );
}
