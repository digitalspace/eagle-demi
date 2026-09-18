import { ApiError, api, type ApiInit } from './client';

/** What the loader asks for. The API caps list reads at 1000 whatever is sent. */
export const SEARCH_PAGE_SIZE = 500;
export const SEARCH_RETRIES = 2;
export const SEARCH_RETRY_DELAY_MS = 1000;

export type Dataset = 'Project' | 'Document';

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
  const body = await api<{ searchResults?: T[]; count?: number }[] | null>(
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
