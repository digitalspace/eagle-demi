/**
 * The grid's URL schema. Pure functions over `URLSearchParams`, with no router, so the route
 * service, a legacy redirect and the specs can all read and write the same view state.
 */

import type { FilterValue, FilterValues } from './grid-types';

export type RecordType = 'projects' | 'documents' | 'activities' | 'notifications';
export type SearchScope = 'names' | 'inside';

export const RECORD_TYPES: RecordType[] = ['projects', 'documents', 'activities', 'notifications'];
export const PAGE_SIZES = [10, 25, 50, 100];

/* Documents: what a bare /search has always listed, from the Angular page through to the design. */
export const DEFAULT_RECORD: RecordType = 'documents';
export const DEFAULT_PAGE_SIZE = 25;
/** Names & details sorts by posted date; inside-document search sorts by match count. */
export const DEFAULT_SORT = '-datePosted';
export const INSIDE_SORT = '-matches';

/** URL keys the grid owns. Anything else on the query string is a filter id. */
export const RESERVED_PARAMS = [
  'keywords',
  'record',
  'scope',
  'sortBy',
  'currentPage',
  'pageSize',
  'cols',
];

export interface GridUrlState {
  keywords: string;
  record: RecordType;
  scope: SearchScope;
  sortBy: string;
  /** 1-based, as the API counts pages. */
  currentPage: number;
  pageSize: number;
  /** Columns the reader has switched off. */
  hiddenColumns: string[];
  /** Filter id to value. A multi-value filter carries an array. */
  filters: FilterValues;
}

export interface GridDefaults {
  /** Sort applied when the URL names none, and restored when the scope returns to names. */
  defaultSort?: string;
  defaultPageSize?: number;
}

/** A query string as a plain object, so callers can merge before writing back. */
export function paramsToObject(search: URLSearchParams): Record<string, string> {
  return Object.fromEntries(search.entries());
}

/** Drops null, undefined and empty entries, matching how the router omitted them. */
export function toSearchParams(params: Record<string, unknown>): URLSearchParams {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    next.set(key, String(value));
  }
  return next;
}

/**
 * `URLSearchParams` form-decodes `+` to a space, so an Angular-era deep link such as
 * `?sortBy=+name` arrives here as `" name"`. Restore the sign rather than issuing a request the
 * API cannot sort by.
 */
export function normalizeSortBy(value: string): string {
  return value.startsWith(' ') ? `+${value.slice(1)}` : value;
}

/**
 * Flips the sort direction when the same column is clicked again, otherwise starts at `fallback`.
 * Matches the whole field name: `+displayName` and a click on `name` are different columns.
 */
export function toggleSortDirection(
  currentSort: string | undefined,
  field: string,
  fallback: '+' | '-' = '+',
): string {
  if (currentSort && currentSort.replace(/^[+-]/, '') === field) {
    return (currentSort[0] === '+' ? '-' : '+') + field;
  }
  return fallback + field;
}

export function readFilterValue(raw: string): FilterValue {
  // A comma is how a multi-select column writes several picks; a single pick stays a string so
  // callers do not have to unwrap one-element arrays everywhere.
  return raw.includes(',') ? raw.split(',').filter((part) => part !== '') : raw;
}

/** Reads the grid's URL schema off a query string. */
export function parseGridParams(search: URLSearchParams, defaults: GridDefaults = {}): GridUrlState {
  const params = paramsToObject(search);
  const record = RECORD_TYPES.includes(params['record'] as RecordType)
    ? (params['record'] as RecordType)
    : DEFAULT_RECORD;
  const scope: SearchScope = params['scope'] === 'inside' ? 'inside' : 'names';

  const page = Number.parseInt(String(params['currentPage'] ?? ''), 10);
  const size = Number.parseInt(String(params['pageSize'] ?? ''), 10);

  const filters: FilterValues = {};
  for (const [key, value] of Object.entries(params)) {
    if (RESERVED_PARAMS.includes(key) || value == null || value === '') continue;
    filters[key] = readFilterValue(String(value));
  }

  return {
    keywords: String(params['keywords'] ?? ''),
    record,
    scope,
    sortBy: params['sortBy']
      ? normalizeSortBy(String(params['sortBy']))
      : scope === 'inside'
        ? INSIDE_SORT
        : (defaults.defaultSort ?? DEFAULT_SORT),
    currentPage: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZES.includes(size) ? size : (defaults.defaultPageSize ?? DEFAULT_PAGE_SIZE),
    hiddenColumns: params['cols'] ? String(params['cols']).split(',').filter(Boolean) : [],
    filters,
  };
}

/** The inverse: state back to a query string, with defaults and empty values left out. */
export function serializeGridParams(
  state: GridUrlState,
  defaults: GridDefaults = {},
): URLSearchParams {
  const out: Record<string, unknown> = {
    keywords: state.keywords || null,
    record: state.record === DEFAULT_RECORD ? null : state.record,
    scope: state.scope === 'names' ? null : state.scope,
    sortBy: state.sortBy || null,
    currentPage: state.currentPage > 1 ? state.currentPage : null,
    pageSize:
      state.pageSize === (defaults.defaultPageSize ?? DEFAULT_PAGE_SIZE) ? null : state.pageSize,
    cols: state.hiddenColumns.length > 0 ? state.hiddenColumns.join(',') : null,
  };

  for (const [id, value] of Object.entries(state.filters)) {
    const joined = Array.isArray(value) ? value.join(',') : value;
    out[id] = joined || null;
  }

  return toSearchParams(out);
}
