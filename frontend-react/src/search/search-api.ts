import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../api/client';
import { fetchListRows, type WireEnvelope } from '../api/search';
import { trackException } from '../telemetry';
import type { FilterValues, PassageHit, PassageRow } from './grid-types';
import { RECORD_TYPES, type RecordType } from './grid-url';
import { RECORD_DATASETS, type OptionSource, type SearchMeta } from './record-types';
import { toWireFilters } from './search-filters';

/** Shortest keyword worth a round trip. One character matches most of the corpus. */
export const MIN_KEYWORD_LENGTH = 2;

/** How long typing has to stop before a request goes out. */
export const SEARCH_DEBOUNCE_MS = 300;

/** One page holds every row of these small collections; callers need all of them at once. */
const ALL_ROWS_PAGE_SIZE = 250;

/** The company types whose organizations fill the proponent filter. */
export const PROPONENT_COMPANY_TYPE = 'Proponent/Certificate Holder';

export type SearchRow = Record<string, unknown>;

type SearchEnvelope = WireEnvelope<SearchRow, SearchMeta>;

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
 * The query string the search endpoint takes. The one place filters are wrapped as `and[]`: a value
 * holding several picks is split on commas into one `and[]` each, which is how the backend reads an
 * OR within one field.
 */
export function buildSearchQuery(request: SearchRequest): string {
  let query = `search?dataset=${request.dataset}`;
  if (request.keywords) query += `&keywords=${request.keywords}`;
  query += `&pageNum=${request.pageNum - 1}`;
  query += `&pageSize=${request.pageSize}`;
  // Encoded, or a `+` arrives as a space.
  if (request.sortBy) query += `&sortBy=${encodeURIComponent(request.sortBy)}`;
  const wire = toWireFilters(request.filters ?? {}, request.yearIds, request.textIds);
  const textIds = request.textIds ?? [];
  for (const [key, value] of Object.entries(wire)) {
    const name = encodeURIComponent(key);
    // A typed name arrives percent-encoded from `toWireFilters`, which keeps a comma in it from
    // splitting; escaping it again would search for the escapes.
    if (textIds.includes(key)) {
      query += `&and[${name}]=${value}`;
      continue;
    }
    // Each pick is escaped: a `#` would start the fragment, a `+` would reach the parser as a space.
    for (const item of value.split(',')) {
      query += `&and[${name}]=${encodeURIComponent(item)}`;
    }
  }
  query += `&fuzzy=${request.fuzzy === true}`;
  return query;
}

function rowsFrom(payload: SearchEnvelope[] | null | undefined): SearchRow[] {
  return payload?.[0]?.searchResults ?? [];
}

/** A grouped `DocumentChunk` row as the passage list reads one. */
export function passageRowFrom(row: SearchRow, href: string): PassageRow {
  const passages = Array.isArray(row['passages']) ? (row['passages'] as Record<string, unknown>[]) : [];
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

export async function runSearch(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
  const payload = await api<SearchEnvelope[] | null>(
    `/${buildSearchQuery({ ...request, keywords: encodeURIComponent(searchKeyword(request.keywords)) })}`,
    { signal },
  );
  return {
    rows: rowsFrom(payload),
    total: payload?.[0]?.meta?.[0]?.searchResultsTotal ?? null,
    meta: payload?.[0]?.meta ?? null,
  };
}

/**
 * Set by the one 404 this session is allowed to take. An endpoint that is not deployed will not
 * appear halfway through a visit, so the page probes `search/counts` once and then stops asking.
 */
let countsUnsupported = false;

/** Test seam: each spec starts with the endpoint assumed deployed. */
export function resetCountsProbe(): void {
  countsUnsupported = false;
}

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

/** A count is a badge rather than the page, so a failed read is traced and the page carries on. */
function traceCounts(error: unknown): void {
  trackException(error, { area: 'UnifiedSearch', action: 'counts' });
}

const isAbort = (error: unknown) => (error as { name?: string } | null)?.name === 'AbortError';

/**
 * What the tabs showed before `search/counts` existed: one one-row search per type, read for its
 * total. Four requests instead of one, which is why it is the fallback and not the path.
 */
async function countsFromSearches(keywords: string, signal?: AbortSignal): Promise<TypeCounts> {
  const encoded = encodeURIComponent(keywords);
  // Settled, not all: one dataset that fails costs its own badge rather than the other three.
  const settled = await Promise.allSettled(
    RECORD_TYPES.map((id) =>
      api<SearchEnvelope[] | null>(
        `/${buildSearchQuery({ dataset: RECORD_DATASETS[id], keywords: encoded, pageNum: 1, pageSize: 1 })}`,
        { signal },
      ),
    ),
  );
  const out = unknownCounts();
  RECORD_TYPES.forEach((id, index) => {
    const result = settled[index];
    if (result.status === 'rejected') {
      if (isAbort(result.reason)) throw result.reason;
      traceCounts(result.reason);
      return;
    }
    const value = result.value?.[0]?.meta?.[0]?.searchResultsTotal;
    out[id] = typeof value === 'number' ? value : null;
  });
  return out;
}

export async function readCounts(keywords: string, signal?: AbortSignal): Promise<TypeCounts> {
  const term = searchKeyword(keywords);
  if (!countsUnsupported) {
    try {
      const payload = await api<CountsEnvelope[] | null>(
        `/search/counts?keywords=${encodeURIComponent(term)}`,
        { signal },
      );
      return fromCountsEnvelope(payload);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      countsUnsupported = true;
    }
  }
  return countsFromSearches(term, signal);
}

/** The record-type badges. The last totals stay up while the next keyword's are read. */
export function useTypeCounts(keywords: string): TypeCounts | null {
  const term = searchKeyword(keywords);
  const { data } = useQuery({
    queryKey: ['unified-search-counts', term],
    queryFn: async ({ signal }) => {
      try {
        return await readCounts(term, signal);
      } catch (error) {
        if (!isAbort(error)) traceCounts(error);
        throw error;
      }
    },
    placeholderData: (previous) => previous,
  });
  // A failed read keeps the last badges up rather than blanking every tab.
  const [kept, setKept] = useState<TypeCounts | null>(null);
  if (data && data !== kept) setKept(data);
  return data ?? kept;
}

/** Dropdown list items. One page holds them all. */
const loadLists = (signal?: AbortSignal) => fetchListRows<OptionSource>({ signal });

/** Every organization of the proponent company type, for the proponent filter dropdown. */
async function loadOrganizations(signal?: AbortSignal): Promise<OptionSource[]> {
  const query = buildSearchQuery({
    dataset: 'Organization',
    keywords: '',
    pageNum: 1,
    pageSize: ALL_ROWS_PAGE_SIZE,
    sortBy: '+name',
    filters: { companyType: PROPONENT_COMPANY_TYPE },
  });
  return rowsFrom(await api<SearchEnvelope[] | null>(`/${query}`, { signal })) as OptionSource[];
}

const EMPTY: OptionSource[] = [];

/** The `List` and `Organization` rows every record type builds its dropdowns from. */
export function useFilterSources(): { lists: OptionSource[]; orgs: OptionSource[] } {
  const lists = useQuery({
    queryKey: ['search', 'List'],
    queryFn: ({ signal }) => loadLists(signal),
    staleTime: Infinity,
  });
  const orgs = useQuery({
    queryKey: ['search', 'Organization', PROPONENT_COMPANY_TYPE],
    queryFn: ({ signal }) => loadOrganizations(signal),
    staleTime: Infinity,
  });
  return { lists: lists.data ?? EMPTY, orgs: orgs.data ?? EMPTY };
}
