import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { WorkRow } from './derive';
import { activeByQuarter } from './timeline-activity';
import { dayNumber, xOf, type Scale } from './timeline-scale';

const DAY_MS = 86_400_000;
const QUARTER_DAYS = 365.25 / 4;
const MONTH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthYear = (day: number) => MONTH_YEAR.format(new Date(day * DAY_MS));
const yearOf = (day: number) => new Date(day * DAY_MS).getUTCFullYear();

interface Props {
  rows: WorkRow[];
  scale: Scale;
  lanePx: number;
  today: string;
  /** The lane's scroll box; the window follows its scroll events. */
  scroller: RefObject<HTMLDivElement | null>;
  /** Scrolls the lane to `px` from its left end. */
  onPan: (px: number) => void;
}

/** Works active per quarter over the whole lane, with a window on the part in view; drag it, or use arrow keys, to pan. */
export function TimelineOverview({ rows, scale, lanePx, today, scroller, onPan }: Props) {
  const [x, setX] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  // Lane px between the window's left edge and the pointer, while dragging.
  const grab = useRef<number | null>(null);
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const follow = () => setX(box.scrollLeft);
    follow();
    box.addEventListener('scroll', follow, { passive: true });
    return () => box.removeEventListener('scroll', follow);
    // Re-read on a new scale too: the view sets scrollLeft in a layout effect, before any scroll event fires.
  }, [scroller, scale, lanePx]);

  const cells = useMemo(() => activeByQuarter(rows, scale), [rows, scale]);
  const peak = Math.max(1, ...cells.map((cell) => cell.count));
  const max = Math.max(0, scale.width - lanePx);
  const pct = (px: number) => `${(px / scale.width) * 100}%`;
  const pan = (to: number) => {
    const next = Math.round(Math.min(max, Math.max(0, to)));
    onPan(next);
    setX(next);
  };
  const laneAt = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return ((clientX - box.left) / box.width) * scale.width;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = laneAt(event.clientX);
    const inside = at >= x && at <= x + lanePx;
    grab.current = inside ? at - x : lanePx / 2;
    if (!inside) pan(at - grab.current);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const release = () => {
    grab.current = null;
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (grab.current !== null) pan(laneAt(event.clientX) - grab.current);
  };
  const quarter = QUARTER_DAYS * scale.pxPerDay;
  const moves: Record<string, () => number> = {
    ArrowLeft: () => x - quarter,
    ArrowDown: () => x - quarter,
    ArrowRight: () => x + quarter,
    ArrowUp: () => x + quarter,
    PageUp: () => x - lanePx,
    PageDown: () => x + lanePx,
    Home: () => 0,
    End: () => max,
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const to = moves[event.key];
    if (!to) return;
    event.preventDefault();
    pan(to());
  };

  const from = scale.start + x / scale.pxPerDay;
  const to = scale.start + (x + lanePx) / scale.pxPerDay;
  return (
    <div className="timeline__overview">
      <p className="timeline__overview-label">
        <b>
          Overview {yearOf(scale.start)}–{yearOf(scale.end - 1)}
        </b>{' '}
        · drag the window to pan
      </p>
      <div
        className="timeline__overview-track"
        ref={track}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        {cells.map((cell) => (
          <span
            key={cell.start}
            className="timeline__overview-bar"
            aria-hidden="true"
            style={{
              left: pct(xOf(scale, cell.start)),
              width: pct((cell.end - cell.start) * scale.pxPerDay),
              height: `${8 + (92 * cell.count) / peak}%`,
            }}
          />
        ))}
        <span
          className="timeline__overview-today"
          aria-hidden="true"
          style={{ left: pct(xOf(scale, dayNumber(today))) }}
        />
        <div
          className="timeline__overview-window"
          role="slider"
          tabIndex={0}
          aria-label="Visible range"
          aria-valuemin={0}
          aria-valuemax={Math.round(max)}
          aria-valuenow={Math.round(x)}
          aria-valuetext={`Showing ${monthYear(from)} to ${monthYear(to)}`}
          style={{ left: pct(x), width: pct(lanePx) }}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
