import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { MY_DATA_TIMEOUT_MS, toQueryParams, useMyData, useSaveQuery } from './me';
import { json, respond, urlOf } from '../test-http';
import { queryWrapper } from '../test-query';
import { ANONYMOUS_SESSION, SessionContext } from '../session/session';

vi.mock('../config', () => ({ config: () => ({ API_PATH: '/api', KEYCLOAK_ENABLED: false }) }));
vi.mock('./keycloak', () => ({ getToken: () => 'staff-token', refreshToken: async () => false }));

const signedIn = ({ children }: { children: ReactNode }) =>
  createElement(queryWrapper(), {
    children: createElement(
      SessionContext.Provider,
      { value: { ...ANONYMOUS_SESSION, authenticated: true, settled: true } },
      children,
    ),
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('toQueryParams', () => {
  it('percent-encodes what PUT /me/queries would refuse in params', () => {
    expect(toQueryParams('?keywords=Site C & D&record=projects')).toBe(
      'keywords=Site%20C%20&%20D&record=projects',
    );
  });

  it('keeps the characters the API accepts as they are', () => {
    expect(toQueryParams('?record=documents&sort=-datePosted&page=2')).toBe(
      'record=documents&sort=-datePosted&page=2',
    );
  });
});

describe('useSaveQuery', () => {
  it('sends the encoded params to PUT /me/queries', async () => {
    const fetchMock = respond(json({ ok: true }), json({ prefs: null, lassos: [], queries: [] }));

    const { result } = renderHook(() => useSaveQuery(), { wrapper: signedIn });
    await result.current.mutateAsync({ name: 'Peace', search: '?keywords=Site C & D&record=projects' });

    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/me/queries');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Peace',
      params: 'keywords=Site%20C%20&%20D&record=projects',
    });
  });
});

describe('useMyData', () => {
  it('gives up on a hung /me/data rather than waiting forever', async () => {
    // Screens wait on this read, so an API that never answers would hold them open.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const budget = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(10));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('timed out', 'TimeoutError')),
            );
          }),
      ),
    );

    const { result } = renderHook(() => useMyData(), { wrapper: signedIn });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(budget).toHaveBeenCalledWith(MY_DATA_TIMEOUT_MS);
    expect(result.current.data).toBeUndefined();
  });
});
