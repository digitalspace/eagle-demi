import { config } from '../config';
import { ApiError, api, type ApiInit } from './client';

/** What the loader asks for. The API caps list reads at 1000 whatever is sent. */
export const SEARCH_PAGE_SIZE = 500;
export const SEARCH_RETRIES = 2;
export const SEARCH_RETRY_DELAY_MS = 1000;

export type Dataset = 'Project' | 'Document';

/** One `/search` answer as the API sends it, before a loader picks out what it needs. */
export interface WireEnvelope<T, M = unknown> {
  searchResults?: T[];
  count?: number;
  meta?: M[];
}

/**
 * Rows to ask for in the one `List` read. There are about 250, so this fits in a single request;
 * the API caps a page at 1000 and refuses over 100 anonymously.
 */
const LIST_PAGE_SIZE = 1000;

/** Every Eagle `List` row, in one request. */
export async function fetchListRows<T>(init?: ApiInit): Promise<T[]> {
  const body = await api<WireEnvelope<T>[] | null>(`/search?dataset=List&pageSize=${LIST_PAGE_SIZE}`, init);
  return body?.[0]?.searchResults ?? [];
}

/** One `/search` envelope. `count` is the index-wide total, NOT the number of rows returned. */
export interface SearchEnvelope<T> {
  searchResults: T[];
  /** Null when the backend reported none — the keywordless Cosmos list path has no total. */
  count: number | null;
}

/**
 * Sector is deliberately not sent: the controller reads only dataset/keywords/fuzzy/pageSize, and
 * the real sector filtering is client-side, which an OData `eq` would not reproduce.
 */
export function searchQueryString(dataset: Dataset, query: string): string {
  let params = `dataset=${dataset}&pageSize=${SEARCH_PAGE_SIZE}`;
  if (query) params += `&keywords=${encodeURIComponent(query)}&fuzzy=true`;
  return params;
}

export async function searchDataset<T>(
  dataset: Dataset,
  query: string,
  init?: ApiInit,
): Promise<SearchEnvelope<T>> {
  const body = await api<WireEnvelope<T>[] | null>(
    `/search?${searchQueryString(dataset, query)}`,
    init,
  );
  const envelope = body?.[0];
  return { searchResults: envelope?.searchResults ?? [], count: envelope?.count ?? null };
}

/** Angular's fetchWithRetry budget: intermittent 5xx, 429 and network errors, nothing else. */
export function isRetryableSearchError(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 500 || error.status === 429;
  // A cancelled request is not a failure; retrying it resurrects a search already moved past.
  return !(error instanceof Error && error.name === 'AbortError');
}

export const searchRetry = {
  retry: (failureCount: number, error: unknown) =>
    failureCount < SEARCH_RETRIES && isRetryableSearchError(error),
  retryDelay: SEARCH_RETRY_DELAY_MS,
} as const;

/** One `[n]` citation in an AI summary, resolved server-side back to the chunk it points at. */
export interface SummaryCitation {
  n: number;
  chunkId: string;
  documentId: string;
  projectId: string;
  pageNumber: number;
  /**
   * Hydrated server-side, under the caller's access, for cited chunks only. Names are a disclosure
   * about the row they describe, so they are resolved behind the same ACL.
   */
  documentName: string;
  projectName: string;
}

export interface SummaryAnswer {
  summary: string | null;
  citations: SummaryCitation[];
  estimatedCostCad: number | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** `summary: null` with a reason is a legitimate answer, not a failure. */
  reason: string | null;
}

/**
 * Ask the summariser. Reads `/search/summary` and nothing else, so no result list is disturbed.
 *
 * No client budget on purpose: the answer takes seconds, and the only ceiling either app sets is
 * the dev proxy's 350 s (`vite.config.ts`). A read timeout here would cut off
 * answers that are still coming.
 */
export async function fetchSearchSummary(query: string, init?: ApiInit): Promise<SummaryAnswer> {
  // Demo mode must not reach the API. A null answer with a reason reads as "nothing to show"
  // rather than hanging on the loading state.
  if (config().USE_MOCK_DATA) {
    return { summary: null, citations: [], estimatedCostCad: null, usage: null, reason: 'mock_mode' };
  }

  const data = await api<Partial<SummaryAnswer> | null>(
    `/search/summary?keywords=${encodeURIComponent(query)}&fuzzy=true`,
    init,
  );
  return {
    summary: data?.summary ?? null,
    citations: data?.citations ?? [],
    estimatedCostCad: data?.estimatedCostCad ?? null,
    usage: data?.usage ?? null,
    reason: data?.reason ?? null,
  };
}
