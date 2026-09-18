import { Injectable, inject, signal } from '@angular/core';
import { RegistryStateService } from '../services/registry-state.service';
import type { FilterValues, PassageHit, PassageRow } from './grid-types';
import { RECORD_TYPES, type RecordType } from './grid-url';
import { toWireFilters } from './search-filters';
import { RECORD_DATASETS, type OptionSource, type SearchMeta } from './record-types';

/** Shortest keyword worth a round trip. One character matches most of the corpus. */
export const MIN_KEYWORD_LENGTH = 2;

/** How long typing has to stop before a request goes out. */
export const SEARCH_DEBOUNCE_MS = 300;

/** One page holds every row of these small collections; callers need all of them at once. */
const ALL_ROWS_PAGE_SIZE = 250;

/** The company types whose organizations fill the proponent filter. */
export const PROPONENT_COMPANY_TYPE = 'Proponent/Certificate Holder';

export type SearchRow = Record<string, unknown>;

/** The envelope every `/search` dataset answers on. */
export interface SearchEnvelope {
  searchResults?: SearchRow[];
  meta?: SearchMeta[];
}

export interface SearchRequest {
  dataset: string;
  keywords: string;
  /** 1-based, as the page counts. The wire is 0-based. */
  pageNum: number;
  pageSize: number;
  sortBy?: string | null;
  /** Filter ids to the values the reader picked. The `and[]` wrapping happens here. */
  filters?: FilterValues;
  /** Filter ids holding a year, which becomes the `<id>Start`/`<id>End` range the index takes. */
  yearIds?: string[];
  /** Filter ids holding typed text, which is one value rather than a comma-separated list. */
  textIds?: string[];
  fuzzy?: boolean;
}

export interface SearchResult {
  rows: SearchRow[];
  total: number | null;
  meta: SearchMeta[] | null;
}

/** A count per record type. `null` is "unknown", which the tab renders without a badge. */
export type TypeCounts = Record<RecordType, number | null>;

interface CountsEnvelope {
  counts?: Record<string, number | null>;
}

/**
 * What a typed box searches for. Anything shorter than the minimum searches as an empty keyword:
 * backspacing to one character restores the unfiltered list instead of leaving the last results up.
 */
export function searchKeyword(keywords: string): string {
  return keywords.trim().length >= MIN_KEYWORD_LENGTH ? keywords.trim() : '';
}

/**
 * The query string the search endpoint takes, in the order it has always been written. The one
 * place filters are wrapped as `and[]`: a value holding several picks is split on commas into one
 * `and[]` each, which is how the backend reads an OR within one field.
 */
export function buildSearchQuery(request: SearchRequest): string {
  let query = `search?dataset=${request.dataset}`;
  if (request.keywords) query += `&keywords=${request.keywords}`;
  if (request.pageNum !== null) query += `&pageNum=${request.pageNum - 1}`;
  if (request.pageSize !== null) query += `&pageSize=${request.pageSize}`;
  if (request.sortBy) query += `&sortBy=${request.sortBy}`;
  const wire = toWireFilters(request.filters ?? {}, request.yearIds, request.textIds);
  const textIds = request.textIds ?? [];
  for (const [key, value] of Object.entries(wire)) {
    // A typed name arrives percent-encoded from `toWireFilters`, which is what keeps a comma in it
    // from splitting; escaping it again would search for the escapes. Every other value arrives as
    // the reader wrote it, so each pick is escaped here - a `#` would otherwise start the fragment
    // and never be sent, and a `+` would reach the backend's parser as a space.
    if (textIds.includes(key)) {
      query += `&and[${key}]=${value}`;
      continue;
    }
    for (const item of value.split(',')) {
      query += `&and[${key}]=${encodeURIComponent(item)}`;
    }
  }
  query += `&fuzzy=${request.fuzzy === true}`;
  return query;
}

/** Rows out of an envelope, whichever of the two shapes the endpoint answered on. */
function rowsFrom(payload: SearchEnvelope[] | null | undefined): SearchRow[] {
  return payload?.[0]?.searchResults ?? [];
}

/** A grouped `DocumentChunk` row as the passage list reads one. */
export function passageRowFrom(row: SearchRow, href: string): PassageRow {
  const passages = Array.isArray(row['passages'])
    ? (row['passages'] as Record<string, unknown>[])
    : [];
  const hits: PassageHit[] = passages.map((passage, index) => {
    const pageNumbered = passage['pageNumbered'] === true;
    const page = Number(passage['pageNumber']);
    return {
      // Without a real page number the locator is only the passage's place in what came back.
      locator: pageNumbered && Number.isFinite(page) ? page : index + 1,
      text: String(passage['text'] ?? ''),
      pageNumbered,
    };
  });
  return {
    id: String(row['documentId'] ?? row['_id'] ?? ''),
    name: String(row['documentName'] ?? ''),
    href,
    date: (row['datePosted'] as string | null) ?? null,
    type: (row['documentType'] as string | null) ?? null,
    author: (row['documentAuthorType'] as string | null) ?? null,
    passages: hits,
    total: typeof row['matchCount'] === 'number' ? row['matchCount'] : hits.length,
  };
}

/**
 * Every read the unified search page makes.
 *
 * One request per typing pause per leg: a new pause aborts whatever the last one left in flight,
 * because two answers to two different keywords race and the loser can win. Rows already on screen
 * stay there while the next answer loads, so a keystroke never blanks the grid.
 */
@Injectable({ providedIn: 'root' })
export class UnifiedSearchService {
  private registry = inject(RegistryStateService);

  readonly rows = signal<SearchRow[]>([]);
  readonly total = signal<number | null>(null);
  readonly meta = signal<SearchMeta[] | null>(null);
  readonly counts = signal<TypeCounts | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  private searchAbort: AbortController | null = null;
  private countsAbort: AbortController | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Set by the one 404 this session is allowed to take. An endpoint that is not deployed will not
   * appear halfway through a visit, so the page probes `search/counts` once and then stops asking.
   */
  private countsUnsupported = false;

  /** Waits for typing to stop, then runs one search and one counts read against the same term. */
  queueSearch(request: SearchRequest): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.search(request);
      void this.loadCounts(request.keywords);
    }, SEARCH_DEBOUNCE_MS);
  }

  /** Runs a search now, superseding the one in flight. */
  async search(request: SearchRequest): Promise<SearchResult | null> {
    const signal = this.nextSearchSignal();
    this.loading.set(true);
    this.error.set(null);
    try {
      const payload = await this.getJson<SearchEnvelope[]>(
        `${this.basePath()}/${buildSearchQuery({
          ...request,
          keywords: encodeURIComponent(searchKeyword(request.keywords)),
        })}`,
        signal,
      );
      const result: SearchResult = {
        rows: rowsFrom(payload),
        total: payload?.[0]?.meta?.[0]?.searchResultsTotal ?? null,
        meta: payload?.[0]?.meta ?? null,
      };
      // Assigned together, so a render never sees new rows against an old total.
      this.rows.set(result.rows);
      this.total.set(result.total);
      this.meta.set(result.meta);
      this.loading.set(false);
      return result;
    } catch (err) {
      // An aborted request was replaced, not failed: the newer one owns the signals now.
      if (isAbortError(err)) return null;
      this.error.set(err instanceof Error ? err.message : 'Search failed');
      this.loading.set(false);
      return null;
    }
  }

  /**
   * The totals the record-type tabs badge. One request per pause, and the last answer left on
   * screen while the next one loads.
   */
  async loadCounts(keywords: string): Promise<TypeCounts | null> {
    this.countsAbort?.abort();
    const abort = new AbortController();
    this.countsAbort = abort;
    const term = searchKeyword(keywords);
    try {
      const counts = await this.readCounts(term, abort.signal);
      this.counts.set(counts);
      return counts;
    } catch (err) {
      // An aborted read was superseded by the next pause; anything else is a failure worth a trace,
      // because the badges keep showing the last totals and nothing else says they are stale.
      if (isAbortError(err)) return null;
      warnCounts(err);
      return null;
    }
  }

  /** Dropdown list items. One page holds them all. */
  async loadLists(): Promise<OptionSource[]> {
    const payload = await this.getJson<SearchEnvelope[]>(
      `${this.basePath()}/search?dataset=List&pageSize=${ALL_ROWS_PAGE_SIZE}`,
    );
    return rowsFrom(payload) as OptionSource[];
  }

  /** Every organization of the proponent company type, for the proponent filter dropdown. */
  async loadOrganizations(): Promise<OptionSource[]> {
    const payload = await this.getJson<SearchEnvelope[]>(
      `${this.basePath()}/${buildSearchQuery({
        dataset: 'Organization',
        keywords: '',
        pageNum: 1,
        pageSize: ALL_ROWS_PAGE_SIZE,
        sortBy: '+name',
        filters: { companyType: PROPONENT_COMPANY_TYPE },
      })}`,
    );
    return rowsFrom(payload) as OptionSource[];
  }

  private basePath(): string {
    return this.registry.getBasePath();
  }

  private nextSearchSignal(): AbortSignal {
    this.searchAbort?.abort();
    const abort = new AbortController();
    this.searchAbort = abort;
    return abort.signal;
  }

  private async readCounts(keywords: string, signal: AbortSignal): Promise<TypeCounts> {
    if (!this.countsUnsupported) {
      try {
        const payload = await this.getJson<CountsEnvelope[]>(
          `${this.basePath()}/search/counts?keywords=${encodeURIComponent(keywords)}`,
          signal,
        );
        return fromCountsEnvelope(payload);
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (!(err instanceof HttpStatusError) || err.status !== 404) throw err;
        this.countsUnsupported = true;
      }
    }
    return this.countsFromSearches(keywords, signal);
  }

  /**
   * What the tabs showed before `search/counts` existed: one one-row search per type, read for its
   * total. Four requests instead of one, which is why it is the fallback and not the path.
   */
  private async countsFromSearches(keywords: string, signal: AbortSignal): Promise<TypeCounts> {
    const encoded = encodeURIComponent(keywords);
    // Settled, not all: one dataset that fails costs its own badge rather than the other three.
    const settled = await Promise.allSettled(
      RECORD_TYPES.map((id) =>
        this.getJson<SearchEnvelope[]>(
          `${this.basePath()}/${buildSearchQuery({
            dataset: RECORD_DATASETS[id],
            keywords: encoded,
            pageNum: 1,
            pageSize: 1,
          })}`,
          signal,
        ),
      ),
    );
    const out = unknownCounts();
    RECORD_TYPES.forEach((id, index) => {
      const result = settled[index];
      if (result.status === 'rejected') {
        // An abort cancelled all four at once: that is the caller's to swallow, not a failure.
        if (isAbortError(result.reason)) throw result.reason;
        warnCounts(result.reason);
        return;
      }
      const value = result.value?.[0]?.meta?.[0]?.searchResultsTotal;
      out[id] = typeof value === 'number' ? value : null;
    });
    return out;
  }

  /**
   * A JSON GET. The bearer token is attached by the global fetch interceptor, so there is no header
   * to set here.
   */
  private async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, signal ? { signal } : {});
    // The abort is checked here as well as left to fetch. A response that arrives after its pause
    // was superseded is a stale answer whatever delivered it, and letting it through is how an
    // older keyword's rows end up on screen under a newer one.
    if (signal?.aborted) throw abortError();
    if (!response.ok) throw new HttpStatusError(url, response.status);
    const payload = (await response.json()) as T;
    if (signal?.aborted) throw abortError();
    return payload;
  }
}

/** A response the caller has to branch on by status, which a bare `Error` cannot carry. */
export class HttpStatusError extends Error {
  constructor(
    url: string,
    readonly status: number,
  ) {
    super(`Request to ${url} failed with status ${status}`);
    this.name = 'HttpStatusError';
  }
}

/** Cancellation, however the platform spells it. Safari uses a plain Error with this name. */
function isAbortError(err: unknown): boolean {
  return Boolean(err) && (err as { name?: string }).name === 'AbortError';
}

/** A count is a badge rather than the page, so a failed read is logged and the page carries on. */
function warnCounts(err: unknown): void {
  console.warn('[search] counts read failed; tab totals may be stale', err);
}

/** What an aborted request rejects with, in the shape `isAbortError` reads. */
function abortError(): Error {
  const err = new Error('Request superseded');
  err.name = 'AbortError';
  return err;
}

/** A total per record type, none of them known. */
function unknownCounts(): TypeCounts {
  return Object.fromEntries(RECORD_TYPES.map((id) => [id, null])) as TypeCounts;
}

/** The endpoint answers per dataset name, and omits or nulls a type it could not measure. */
function fromCountsEnvelope(payload: CountsEnvelope[] | null | undefined): TypeCounts {
  const counts = payload?.[0]?.counts ?? {};
  const out = unknownCounts();
  for (const id of RECORD_TYPES) {
    const value = counts[RECORD_DATASETS[id]];
    out[id] = typeof value === 'number' ? value : null;
  }
  return out;
}
