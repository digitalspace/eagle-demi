import { useCallback, useMemo, useState } from 'react';
import { firstDay, recordGeometry, type RecordAxis, type RecordGeometry } from './record-axis';
import type { RecordParts, RecordProject } from './record-header';
import { recordModel, type RecordModel } from './record-model';

/** A value that belongs to one record; read back as missing once the page shows another. */
interface Keyed<T> {
  key: string;
  value: T;
}

const NONE_OPEN: Readonly<Record<string, boolean>> = {};

function useKeyed<T>(key: string, start: T): [T, (next: (was: T) => T) => void] {
  const [state, setState] = useState<Keyed<T> | null>(null);
  const value = state?.key === key ? state.value : start;
  const set = useCallback(
    (next: (was: T) => T) => setState((was) => ({ key, value: next(was?.key === key ? was.value : start) })),
    [key, start],
  );
  return [value, set];
}

export interface RecordModelState {
  geo: RecordGeometry;
  model: RecordModel;
  /** The day the chart opens on: the first dated step, else the first later work. */
  first: number;
  /** Measured width of the track viewport; changes under 2 px are ignored. */
  onViewPx: (px: number) => void;
  /** Opens or closes a later work's phases. */
  onToggle: (workId: string) => void;
}

/** The record's model at the chosen time scale and measured width, with the later works' disclosure state. */
export function useRecordModel(
  project: RecordProject,
  act: number,
  parts: RecordParts,
  today: string,
  axis: RecordAxis,
  zoom: number,
): RecordModelState {
  const key = `${project.projectId}|${act}`;
  const [viewPx, setViewPx] = useState(940);
  const [open, setOpen] = useKeyed(key, NONE_OPEN);
  const geo = useMemo(() => recordGeometry(axis, zoom, viewPx), [axis, zoom, viewPx]);
  const model = useMemo(() => recordModel({ project, act, parts, today, geo, open }), [project, act, parts, today, geo, open]);
  const first = firstDay(model.steps, parts.later, axis, today);
  const onViewPx = useCallback((px: number) => setViewPx((was) => (Math.abs(was - px) > 1 ? px : was)), []);
  const onToggle = useCallback((workId: string) => setOpen((was) => ({ ...was, [workId]: !was[workId] })), [setOpen]);
  return { geo, model, first, onViewPx, onToggle };
}

/** Which mark is lit: the hovered or focused entry or limit row, else the picked entry; `back` carries "Back to the list". */
export interface RecordHighlight {
  hlId: string | null;
  pickId: string | null;
  backId: string | null;
  onHover: (id: string, on: boolean) => void;
  onPick: (id: string) => void;
  /** Clears hover, pick and back, as a filter change does. */
  reset: () => void;
  /** Scrolls the chart to the picked entry's mark and focuses it. */
  showMark: (from: Element, id: string) => void;
  /** Returns focus from a mark to its event entry. */
  backToList: (from: Element, id: string) => void;
}

interface Lit {
  hov: string | null;
  pick: string | null;
  back: string | null;
}

const NONE: Lit = { hov: null, pick: null, back: null };

/** Highlight state of one record, shared by the chart, Time limit changes and Events. */
export function useRecordHighlight(recordKey: string, scrollToMark: (from: Element, id: string) => boolean): RecordHighlight {
  const [lit, setLit] = useKeyed<Lit>(recordKey, NONE);
  const onHover = useCallback(
    (id: string, on: boolean) => setLit((was) => (on ? (was.hov === id ? was : { ...was, hov: id }) : was.hov === id ? { ...was, hov: null } : was)),
    [setLit],
  );
  const onPick = useCallback((id: string) => setLit((was) => ({ ...was, pick: was.pick === id ? null : id, back: null })), [setLit]);
  const reset = useCallback(() => setLit(() => NONE), [setLit]);
  const showMark = useCallback(
    (from: Element, id: string) => {
      if (scrollToMark(from, id)) setLit(() => ({ hov: null, pick: id, back: id }));
    },
    [scrollToMark, setLit],
  );
  const backToList = useCallback(
    (from: Element, id: string) => {
      setLit((was) => ({ ...was, back: null }));
      const entry = from.closest('.wp-rec')?.querySelector<HTMLElement>(`[data-ev="${CSS.escape(id)}"]`);
      entry?.scrollIntoView({ block: 'center' });
      entry?.focus({ preventScroll: true });
    },
    [setLit],
  );
  return { hlId: lit.hov ?? lit.pick, pickId: lit.pick, backId: lit.back, onHover, onPick, reset, showMark, backToList };
}
