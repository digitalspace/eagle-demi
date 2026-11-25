import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { DEFAULT_ROW_STATE, type RowState, type WorkKind } from './chart-facts';
import { DEFAULT_SORT, ROW_STATES, SORTS, WORK_KINDS, type SortKey } from './overview-rows';
import { ZOOMS, type Zoom } from './time-scale';

/** The Overview controls kept in the URL, so Back from a record restores them. */
export interface OverviewParams {
  q: string;
  sort: SortKey;
  /** Work types switched off. */
  off: ReadonlySet<WorkKind>;
  state: RowState;
  /** Phase name, or '' for any. */
  phase: string;
  over: boolean;
  zoom: Zoom;
}

const DEFAULT_ZOOM: Zoom = 'whole';

const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.find((item) => item === value) ?? fallback;

function read(params: URLSearchParams): OverviewParams {
  const kinds = WORK_KINDS.map(([kind]) => kind);
  const types = (params.get('types') ?? '').split(',');
  return {
    q: params.get('q') ?? '',
    sort: oneOf(params.get('sort'), SORTS.map(([key]) => key), DEFAULT_SORT),
    off: new Set(kinds.filter((kind) => types.includes(kind))),
    state: oneOf(params.get('state'), ROW_STATES.map(([key]) => key), DEFAULT_ROW_STATE),
    phase: params.get('phase') ?? '',
    over: params.get('over') === '1',
    zoom: oneOf(params.get('zoom'), ZOOMS.map((level) => level.value), DEFAULT_ZOOM),
  };
}

/** Writes `change` into `params`; a default value drops its param, so a plain Overview keeps a plain URL. */
function write(params: URLSearchParams, change: Partial<OverviewParams>) {
  const put = (name: string, value: string, fallback = '') => {
    if (value === fallback) params.delete(name);
    else params.set(name, value);
  };
  if (change.q !== undefined) put('q', change.q);
  if (change.sort !== undefined) put('sort', change.sort, DEFAULT_SORT);
  if (change.off !== undefined) put('types', WORK_KINDS.flatMap(([kind]) => (change.off?.has(kind) ? [kind] : [])).join(','));
  if (change.state !== undefined) put('state', change.state, DEFAULT_ROW_STATE);
  if (change.phase !== undefined) put('phase', change.phase);
  if (change.over !== undefined) put('over', change.over ? '1' : '');
  if (change.zoom !== undefined) put('zoom', change.zoom, DEFAULT_ZOOM);
}

/** The seven Overview params (`q`, `sort`, `types`, `state`, `phase`, `over`, `zoom`) and a setter that keeps every other param. */
export function useOverviewParams(): [OverviewParams, (change: Partial<OverviewParams>) => void] {
  const [search, setSearch] = useSearchParams();
  const params = useMemo(() => read(search), [search]);
  // Replace, not push: each keystroke and toggle would otherwise be a Back step.
  const update = useCallback(
    (change: Partial<OverviewParams>) =>
      setSearch(
        (current) => {
          const next = new URLSearchParams(current);
          write(next, change);
          return next;
        },
        { replace: true },
      ),
    [setSearch],
  );
  return [params, update];
}
