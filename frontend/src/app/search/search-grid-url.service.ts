import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Params, Router } from '@angular/router';
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

/** The query string as `parseGridParams` reads one. Router params can hold arrays. */
function toSearch(params: Params): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return search;
}

/**
 * The grid's view state, held in the address bar so a view can be linked and shared.
 *
 * Every write is a `replaceUrl` navigation: a keystroke, a chip and a page click are not steps a
 * reader wants to walk back through one at a time.
 */
@Injectable({ providedIn: 'root' })
export class SearchGridUrlService {
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  private defaults = signal<GridDefaults>({});

  private params = toSignal(this.route.queryParams, { initialValue: {} as Params });

  readonly state = computed<GridUrlState>(() =>
    parseGridParams(toSearch(this.params()), this.defaults()),
  );

  /** The record type's own sort and page size, which decide what the URL may leave out. */
  setDefaults(defaults: GridDefaults): void {
    this.defaults.set(defaults);
  }

  setKeyword(keywords: string): void {
    this.patch({ keywords }, true);
  }

  /** Filters and sort belong to one record type; the keyword carries across. */
  setRecord(record: RecordType, defaults: GridDefaults = {}): void {
    this.defaults.set(defaults);
    this.write({
      ...this.state(),
      record,
      filters: {},
      hiddenColumns: [],
      sortBy: defaults.defaultSort ?? '',
      currentPage: 1,
    });
  }

  /** Relevance is the only order inside the documents; the names scope gets its own sort back. */
  setScope(scope: SearchScope): void {
    const sortBy =
      scope === 'inside' ? INSIDE_SORT : (this.defaults().defaultSort ?? DEFAULT_SORT);
    this.patch({ scope, sortBy }, true);
  }

  /** A header click names the column and leaves the direction to the URL it is flipping. */
  setSort(key: string, fallback: '+' | '-' = '+'): void {
    this.patch({ sortBy: toggleSortDirection(this.state().sortBy, key, fallback) }, true);
  }

  /** `null` drops the filter. Narrowing the set moves the reader off whatever page they were on. */
  setFilter(id: string, value: FilterValue | null): void {
    const filters = { ...this.state().filters };
    if (value == null || value.length === 0) delete filters[id];
    else filters[id] = value;
    this.patch({ filters }, true);
  }

  setPage(currentPage: number): void {
    this.patch({ currentPage });
  }

  setPageSize(pageSize: number): void {
    this.patch({ pageSize }, true);
  }

  setHiddenColumns(hiddenColumns: string[]): void {
    this.patch({ hiddenColumns });
  }

  /** Keyword and every filter, leaving the record type and the page size the reader chose. */
  clearAll(): void {
    this.patch({ keywords: '', filters: {} }, true);
  }

  private patch(change: Partial<GridUrlState>, resetPage = false): void {
    const next = { ...this.state(), ...change };
    this.write(resetPage ? { ...next, currentPage: 1 } : next);
  }

  private write(state: GridUrlState): void {
    const queryParams = Object.fromEntries(serializeGridParams(state, this.defaults()));
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      replaceUrl: true,
    });
  }
}
