import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, respond, urlOf } from '../test-http';
import { ApiError } from './client';
import {
  SEARCH_PAGE_SIZE,
  isRetryableSearchError,
  searchDataset,
  searchQueryString,
  searchRetry,
} from './search';

vi.mock('./keycloak', () => ({
  getToken: () => 'staff-token',
  refreshToken: async () => true,
}));

async function bootConfig() {
  respond();
  window.__env = { API_PATH: '/api', API_LOCATION: '' };
  const { initConfig } = await import('../config');
  await initConfig();
}

beforeEach(bootConfig);

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__env;
});

describe('the /search query string', () => {
  it('asks for the whole page and sends no keywords when nothing was typed', () => {
    expect(searchQueryString('Project', '')).toBe(`dataset=Project&pageSize=${SEARCH_PAGE_SIZE}`);
  });

  it('adds fuzzy keywords when something was typed', () => {
    expect(searchQueryString('Document', 'coal mine')).toBe(
      `dataset=Document&pageSize=${SEARCH_PAGE_SIZE}&keywords=coal%20mine&fuzzy=true`,
    );
  });

  it('encodes characters that would otherwise start a new parameter', () => {
    expect(searchQueryString('Project', 'a&b=c')).toContain('keywords=a%26b%3Dc');
  });

  it('never sends a sector parameter, which the controller does not read', () => {
    expect(searchQueryString('Project', 'gold')).not.toContain('sector');
  });
});

describe('reading the envelope', () => {
  it('returns the rows and the index-wide total', async () => {
    const fetchMock = respond(json([{ searchResults: [{ _id: 'a' }], count: 91 }]));

    const result = await searchDataset<{ _id: string }>('Project', 'gold');

    expect(result).toEqual({ searchResults: [{ _id: 'a' }], count: 91 });
    expect(urlOf(fetchMock.mock.calls[0]!)).toContain(
      `/api/search?dataset=Project&pageSize=${SEARCH_PAGE_SIZE}&keywords=gold&fuzzy=true`,
    );
  });

  it('reports no total when the backend sent none, rather than guessing one', async () => {
    respond(json([{ searchResults: [{ _id: 'a' }] }]));

    expect(await searchDataset('Project', '')).toEqual({ searchResults: [{ _id: 'a' }], count: null });
  });

  it('reads an empty answer as no rows', async () => {
    respond(json([]));

    expect(await searchDataset('Document', '')).toEqual({ searchResults: [], count: null });
  });

  it('raises the API error rather than answering with an empty list', async () => {
    respond(json({ error: 'index offline' }, 503));

    await expect(searchDataset('Project', '')).rejects.toThrow('index offline');
  });
});

describe('what a search retries', () => {
  it('retries a server error and a rate limit', () => {
    expect(isRetryableSearchError(new ApiError(503, ''))).toBe(true);
    expect(isRetryableSearchError(new ApiError(429, ''))).toBe(true);
  });

  it('does not retry a refusal or a bad request', () => {
    expect(isRetryableSearchError(new ApiError(403, ''))).toBe(false);
    expect(isRetryableSearchError(new ApiError(400, ''))).toBe(false);
  });

  it('retries a network error but never a cancelled request', () => {
    const aborted = new Error('cancelled');
    aborted.name = 'AbortError';

    expect(isRetryableSearchError(new TypeError('failed to fetch'))).toBe(true);
    expect(isRetryableSearchError(aborted)).toBe(false);
  });

  it('gives up after two retries', () => {
    expect(searchRetry.retry(0, new ApiError(503, ''))).toBe(true);
    expect(searchRetry.retry(1, new ApiError(503, ''))).toBe(true);
    expect(searchRetry.retry(2, new ApiError(503, ''))).toBe(false);
  });
});
