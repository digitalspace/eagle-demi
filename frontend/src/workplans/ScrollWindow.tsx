import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { workEndOf, workStartOf } from './chart-facts';
import { AXIS_W } from './overview-axis';
import type { OverviewActData } from './use-overview-acts';
import { EDGE_PX } from './overview-plot';
import { viewOf } from './use-edge-pass';

/** Pointer travel in px before a press on the window counts as a drag. */
const DRAG_PX = 4;

/** The part of the track in view, and each empty end of the track, as fractions of the track. */
interface Frame {
  left: number;
  width: number;
  edge: number;
}

/** A whole-track frame when the box is too narrow to show any track, so the box covers the strip rather than a sliver. */
function frameOf(box: HTMLElement): Frame {
  const { track, vis } = viewOf(box);
  if (!(track > 0) || !(vis > 0)) return { left: 0, width: 1, edge: 0 };
  const width = Math.min(1, vis / track);
  return { left: Math.min(1 - width, Math.max(0, box.scrollLeft / track)), width, edge: EDGE_PX / track };
}

/** A quarter's bar behind the window: how many of the shown works are active in it, as a share of the busiest quarter. */
interface Busy {
  x: number;
  w: number;
  h: number;
}

const nextQuarter = (day: string) => {
  const [y, m] = day.split('-').map(Number);
  return m >= 10 ? `${y + 1}-01-01` : `${y}-${String(m + 3).padStart(2, '0')}-01`;
};

/** Works active per quarter of the axis, among the rows the filters leave; open works count up to today. */
function busyOf(act: OverviewActData, today: string): Busy[] {
  const { axis } = act;
  if (!axis) return [];
  const spans = act.rows
    .flatMap((row) => row.cand.works)
    .flatMap((w) => {
      const s = workStartOf(w);
      return s ? [[s, workEndOf(w) ?? today] as const] : [];
    });
  const quarters: string[] = [];
  for (let y = axis.y0; y < axis.y0 + axis.years; y++) for (const m of ['01', '04', '07', '10']) quarters.push(`${y}-${m}-01`);
  const counts = quarters.map((q) => {
    const e = nextQuarter(q);
    return spans.filter(([a, b]) => a < e && b >= q).length;
  });
  const most = Math.max(1, ...counts);
  return quarters.flatMap((q, i) => {
    if (!counts[i]) return [];
    const x0 = axis.px(q);
    const x1 = axis.px(nextQuarter(q));
    if (x1 <= x0) return [];
    return [{ x: (x0 / AXIS_W) * 100, w: ((x1 - x0) / AXIS_W) * 100, h: (counts[i] / most) * 100 }];
  });
}

const sameFrame = (a: Frame, b: Frame) => a.left === b.left && a.width === b.width && a.edge === b.edge;

/** The box's furthest scroll, never negative. */
const maxScroll = (box: HTMLElement) => {
  const { track, vis } = viewOf(box);
  return Math.max(0, track - vis);
};

/** Scrolls the box to `x`, kept inside its scroll range. */
const scrollBoxTo = (box: HTMLElement, x: number) => {
  box.scrollLeft = Math.min(maxScroll(box), Math.max(0, x));
};

interface Drag {
  x: number;
  left: number;
  stripPx: number;
}

/**
 * The Act's whole axis with a box over the part in view, always drawn; at the whole range the box covers the strip. The rows box's
 * `scrollLeft` is the one position: the window reads it on every scroll and resize, and drag, click and keys set it.
 */
export function ScrollWindow({ act, box, valueText, today }: { act: OverviewActData; box: RefObject<HTMLElement | null>; valueText: string; today: string }) {
  const busy = useMemo(() => busyOf(act, today), [act, today]);
  const [frame, setFrame] = useState<Frame>({ left: 0, width: 1, edge: 0 });
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      const now = frameOf(el);
      setFrame((was) => (sameFrame(was, now) ? was : now));
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    // The rows inside carry the zoomed width, the box the visible one.
    const ro = new ResizeObserver(read);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', read);
      ro.disconnect();
    };
  }, [box]);

  if (!act.ticks) return null;
  const whole = frame.width > 0.995;

  const years = act.ticks.ticks.filter((tick) => tick.cls === '' && Number(tick.x) > 0);
  const todayLine = act.ticks.gridHi.find((line) => line.cls === 'today');
  const slack = 1 - frame.width;
  const now = slack > 0 ? Math.round(Math.min(1, Math.max(0, frame.left / slack)) * 100) : 0;

  const onStripClick = (event: MouseEvent<HTMLDivElement>) => {
    const el = box.current;
    if (!el || dragged.current || (event.target as Element).closest('.wp-ov-sw-window')) return;
    const strip = event.currentTarget.getBoundingClientRect();
    const { track, vis } = viewOf(el);
    if (strip.width <= 0) return;
    scrollBoxTo(el, ((event.clientX - strip.left) / strip.width) * track - vis / 2);
  };

  const endDrag = () => {
    drag.current = null;
  };

  const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    drag.current = null;
    const strip = event.currentTarget.parentElement;
    const el = box.current;
    if (event.button !== 0 || !strip || !el || strip.clientWidth <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, left: el.scrollLeft, stripPx: strip.clientWidth };
  };

  const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const start = drag.current;
    const el = box.current;
    if (!start || !el) return;
    if (event.buttons === 0) return endDrag();
    const dx = event.clientX - start.x;
    if (!dragged.current && Math.abs(dx) < DRAG_PX) return;
    dragged.current = true;
    scrollBoxTo(el, start.left + (dx / start.stripPx) * viewOf(el).track);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    const el = box.current;
    if (!el) return;
    const { vis } = viewOf(el);
    const at = el.scrollLeft;
    const step = vis * (event.shiftKey ? 0.5 : 0.1);
    const page = vis * 0.5;
    const to: Partial<Record<string, number>> = {
      ArrowLeft: at - step,
      ArrowDown: at - step,
      ArrowRight: at + step,
      ArrowUp: at + step,
      PageDown: at - page,
      PageUp: at + page,
      Home: 0,
      End: maxScroll(el),
    };
    const next = to[event.key];
    if (next === undefined) return;
    event.preventDefault();
    scrollBoxTo(el, next);
  };

  return (
    <div className="wp-ov-sw">
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- pointer shortcut; the slider inside is its keyboard path */}
      <div
        className="wp-ov-sw-strip"
        data-whole={whole || undefined}
        title="Click to move the view"
        onPointerDown={() => {
          dragged.current = false;
        }}
        onClick={onStripClick}
      >
        <span className="wp-ov-sw-plot" style={{ left: `${(frame.edge * 100).toFixed(3)}%`, right: `${(frame.edge * 100).toFixed(3)}%` }}>
          {busy.map((b) => (
            <span key={b.x} className="wp-ov-sw-busy" style={{ left: `${b.x.toFixed(3)}%`, width: `${b.w.toFixed(3)}%`, height: `${b.h.toFixed(1)}%` }} />
          ))}
          {years.map((tick) => (
            <span key={tick.x} className="wp-ov-sw-year" style={{ left: `${tick.x}%` }} />
          ))}
          {todayLine && <span className="wp-ov-sw-today" style={{ left: `${todayLine.x}%` }} />}
        </span>
        <span
          className="wp-ov-sw-window"
          style={{ left: `${(frame.left * 100).toFixed(2)}%`, width: `${(frame.width * 100).toFixed(2)}%` }}
          role="slider"
          tabIndex={0}
          aria-label={`View on the ${act.year} Act timeline`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={now}
          aria-valuetext={valueText || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
