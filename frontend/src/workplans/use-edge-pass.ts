import { useCallback, useEffect, useRef, useState } from 'react';
import { plotAt } from './overview-plot';
import { rangeText } from './overview-rows';
import type { OverviewActData } from './use-overview-acts';
import { drawn, NAME_INSET_PX } from './use-overview-scroll';

interface View {
  track: number;
  vis: number;
  zoomed: boolean;
  /** Visible edges as fractions of the plot, past 0 or 1 over its empty ends. */
  left: number;
  right: number;
}

export function viewOf(box: HTMLElement): View {
  const track = box.scrollWidth - NAME_INSET_PX;
  const vis = box.clientWidth - NAME_INSET_PX;
  return { track, vis, zoomed: track > vis + 1, left: plotAt(box.scrollLeft, track), right: plotAt(box.scrollLeft + vis, track) };
}

const flag = (el: Element, name: string, on: boolean) => {
  if (on !== el.hasAttribute(name)) el.toggleAttribute(name, on);
};

/** Axis labels: hidden when their tick is outside the plot, moved left to end at the plot edge when only the text runs past. */
function shiftAxis(axis: HTMLElement) {
  const ab = axis.getBoundingClientRect();
  const labels = [...axis.querySelectorAll<HTMLElement>('.wp-ov-tkl')];
  labels.forEach((t) => {
    if (t.style.transform) t.style.transform = '';
  });
  const tier = (t: Element) => (t.classList.contains('wp-ov-tkl--upper') || t.classList.contains('wp-ov-tkl--today') ? 'u' : 'l');
  const taken: Record<'u' | 'l', [number, number][]> = { u: [], l: [] };
  const late: [HTMLElement, DOMRect][] = [];
  labels.forEach((t) => {
    const r = t.getBoundingClientRect();
    if (r.left < ab.left - 0.5 || r.left > ab.right - 4) flag(t, 'data-cut', true);
    else if (r.right <= ab.right + 0.5) {
      flag(t, 'data-cut', false);
      taken[tier(t)].push([r.left, r.right]);
    } else late.push([t, r]);
  });
  late.forEach(([t, r]) => {
    const dx = ab.right - 1 - r.right;
    const clash = taken[tier(t)].some(([a, b]) => r.left + dx < b + 6 && r.right + dx > a - 6);
    if (!clash) {
      t.style.transform = `translateX(${dx.toFixed(1)}px)`;
      taken[tier(t)].push([r.left + dx, r.right + dx]);
    }
    flag(t, 'data-cut', clash);
  });
}

/** After any scroll or redraw of one Act: axis label shifts and range text; keeps the axis and rows boxes at one `scrollLeft`. */
export function useEdgePass(act: OverviewActData, open: boolean) {
  const headRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const frame = useRef(0);
  const [range, setRange] = useState('');
  const latest = useRef(act);

  const pass = useCallback(() => {
    frame.current = 0;
    const head = headRef.current;
    const box = rowsRef.current;
    const axis = head?.querySelector<HTMLElement>('.wp-ov-axv') ?? null;
    // A minimized Act's rows stay drawn but hidden; reading them would lay them all out.
    if (!box || !drawn(box)) {
      setRange('');
      return;
    }
    if (axis && Math.abs(axis.scrollLeft - box.scrollLeft) > 0.5) axis.scrollLeft = box.scrollLeft;
    const view = viewOf(box);
    if (view.track <= 0) return;
    if (axis) shiftAxis(axis);
    const { axis: ax } = latest.current;
    setRange(ax ? rangeText(ax.a0, ax.a1, ax.todayIn, view) : '');
  }, []);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(pass);
  }, [pass]);

  useEffect(() => {
    latest.current = act;
    schedule();
  }, [act, open, schedule]);

  // Zeroed so `schedule` queues again when StrictMode mounts the hook a second time.
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );

  const onRowsScroll = useCallback(() => {
    const axis = headRef.current?.querySelector<HTMLElement>('.wp-ov-axv');
    const box = rowsRef.current;
    if (axis && box && Math.abs(axis.scrollLeft - box.scrollLeft) > 0.5) axis.scrollLeft = box.scrollLeft;
    schedule();
  }, [schedule]);

  const onAxisScroll = useCallback(() => {
    const axis = headRef.current?.querySelector<HTMLElement>('.wp-ov-axv');
    const box = rowsRef.current;
    if (axis && box && Math.abs(axis.scrollLeft - box.scrollLeft) > 0.5) box.scrollLeft = axis.scrollLeft;
    schedule();
  }, [schedule]);

  return { headRef, rowsRef, range, onRowsScroll, onAxisScroll };
}
