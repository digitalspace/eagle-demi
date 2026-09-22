import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router';
import type { FilterValue } from './grid-types';
import {
  DEFAULT_SORT,
  INSIDE_SORT,
  parseGridParams,
  serializeGridParams,
  toggleSortDirection,
  type GridDefaults,
  type GridUrlState,
  type RecordType,
  type SearchScope,
} from './grid-url';

/**
 * The grid's view state, held in the address bar so a view can be linked and shared.
 *
 * Every write replaces the history entry: a keystroke, a chip and a page click are not steps a
 * reader wants to walk back through one at a time.
 */
export function useGridUrlState(defaults: GridDefaults) {
  const [params, setParams] = useSearchParams();
  const { defaultSort, defaultPageSize } = defaults;
  const stable = useMemo(() => ({ defaultSort, defaultPageSize }), [defaultSort, defaultPageSize]);
  const state = useMemo(() => parseGridParams(params, stable), [params, stable]);

  // The address as last written, so two writes in one tick compose instead of the second undoing the first.
  const latest = useRef(params);
  useLayoutEffect(() => {
    latest.current = params;
  }, [params]);
  const current = useCallback(() => parseGridParams(latest.current, stable), [stable]);

  const write = useCallback(
    (next: GridUrlState, nextDefaults: GridDefaults = stable) => {
      const out = serializeGridParams(next, nextDefaults);
      latest.current = out;
      setParams(out, { replace: true });
    },
    [setParams, stable],
  );

  const patch = useCallback(
    (change: Partial<GridUrlState> | ((now: GridUrlState) => Partial<GridUrlState>), resetPage = false) => {
      const now = current();
      const next = { ...now, ...(typeof change === 'function' ? change(now) : change) };
      write(resetPage ? { ...next, currentPage: 1 } : next);
    },
    [current, write],
  );

  return {
    state,
    setKeyword: useCallback((keywords: string) => patch({ keywords }, true), [patch]),
    /** Filters and sort belong to one record type; the keyword carries across. */
    setRecord: useCallback(
      (record: RecordType, recordDefaults: GridDefaults) =>
        write(
          {
            ...current(),
            record,
            filters: {},
            hiddenColumns: [],
            sortBy: recordDefaults.defaultSort ?? '',
            currentPage: 1,
          },
          { ...stable, ...recordDefaults },
        ),
      [current, stable, write],
    ),
    /** Relevance is the only order inside the documents; the names scope gets its own sort back. */
    setScope: useCallback(
      (scope: SearchScope) =>
        patch({ scope, sortBy: scope === 'inside' ? INSIDE_SORT : (defaultSort ?? DEFAULT_SORT) }, true),
      [patch, defaultSort],
    ),
    /** A header click names the column and leaves the direction to the URL it is flipping. */
    setSort: useCallback(
      (key: string, fallback: '+' | '-' = '+') =>
        patch((now) => ({ sortBy: toggleSortDirection(now.sortBy, key, fallback) }), true),
      [patch],
    ),
    /** `null` drops the filter. Narrowing the set moves the reader off whatever page they were on. */
    setFilter: useCallback(
      (id: string, value: FilterValue | null) =>
        patch((now) => {
          const filters = { ...now.filters };
          if (value == null || value.length === 0) delete filters[id];
          else filters[id] = value;
          return { filters };
        }, true),
      [patch],
    ),
    setPage: useCallback((currentPage: number) => patch({ currentPage }), [patch]),
    setPageSize: useCallback((pageSize: number) => patch({ pageSize }, true), [patch]),
    setHiddenColumns: useCallback((hiddenColumns: string[]) => patch({ hiddenColumns }), [patch]),
    /** Keyword and every filter, leaving the record type and the page size the reader chose. */
    clearAll: useCallback(() => patch({ keywords: '', filters: {} }, true), [patch]),
  };
}
