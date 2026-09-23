import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config';

const getToken = vi.fn<() => string | undefined>(() => 'staff-token');
const refreshToken = vi.fn<() => Promise<boolean>>(async () => true);

vi.mock('./keycloak', () => ({
  getToken: () => getToken(),
  refreshToken: () => refreshToken(),
}));

/** The API modules read config state at call time, so each test boots its own config. */
async function loadClient(env: AppConfig) {
  vi.resetModules();
  window.__env = env;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
  const { initConfig } = await import('../config');
  await initConfig();
  return import('./client');
}

function authHeader(call: unknown[]): string | null {
  const init = call[1] as RequestInit;
  return new Headers(init.headers).get('Authorization');
}

const signalOf = (call: unknown[]): AbortSignal | null | undefined =>
  (call[1] as RequestInit).signal;

function respond(...responses: Response[]) {
  const fetchMock = vi.fn(async () => responses.shift() ?? new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  getToken.mockReturnValue('staff-token');
  refreshToken.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__env;
});

describe('bearer attachment', () => {
  it('sends the token to the DEMI API', async () => {
    const { api } = await loadClient({ API_PATH: '/api', API_LOCATION: '' });
    const fetchMock = respond(json({ ok: true }));

    await api('/documents/1');

    expect(authHeader(fetchMock.mock.calls[0]!)).toBe('Bearer staff-token');
  });

  // eagle-notify is a different host. Angular's isApiUrl covers the DEMI API alone, and the one
  // notify endpoint that needs a token gets it attached by hand in notify.component.ts.
  it('withholds the token from the eagle-notify origin by default', async () => {
    const { api, notifyBase } = await loadClient({
      API_PATH: '/api',
      API_LOCATION: 'https://demi-api.example.com',
      NOTIFY_API_LOCATION: 'https://notify.example.com',
    });
    const fetchMock = respond(json({ ok: true }));

    await api(`${notifyBase()}/subscriptions`);

    expect(authHeader(fetchMock.mock.calls[0]!)).toBeNull();
  });

  it('sends the token to eagle-notify when the caller names it as the base', async () => {
    const { api, notifyBase } = await loadClient({
      API_PATH: '/api',
      API_LOCATION: 'https://demi-api.example.com',
      NOTIFY_API_LOCATION: 'https://notify.example.com',
    });
    const fetchMock = respond(json({ ok: true }));

    await api(`${notifyBase()}/subscriptions`, { bearerFor: notifyBase()! });

    expect(authHeader(fetchMock.mock.calls[0]!)).toBe('Bearer staff-token');
  });

  // The opt-in is a base, not a switch: a URL that came from somewhere else still has to be inside
  // it, or a value reaching this call from a response or a query string would carry the token off.
  it('withholds the token from another origin even with the notify base opted in', async () => {
    const { api, notifyBase } = await loadClient({
      API_PATH: '/api',
      API_LOCATION: 'https://demi-api.example.com',
      NOTIFY_API_LOCATION: 'https://notify.example.com',
    });
    const fetchMock = respond(json({ ok: true }));

    await api('https://evil.test/collect', { bearerFor: notifyBase()! });

    expect(authHeader(fetchMock.mock.calls[0]!)).toBeNull();
  });

  it('withholds the token from a path outside the opted-in base on the same origin', async () => {
    const { api, notifyBase } = await loadClient({
      API_PATH: '/api',
      API_LOCATION: 'https://demi-api.example.com',
      NOTIFY_API_LOCATION: 'https://notify.example.com/api',
    });
    const fetchMock = respond(json({ ok: true }));

    await api('https://notify.example.com/public/unsubscribe', { bearerFor: notifyBase()! });

    expect(authHeader(fetchMock.mock.calls[0]!)).toBeNull();
  });

  it('strips a caller-supplied Authorization header from a host outside the API', async () => {
    const { api } = await loadClient({ API_PATH: '/api', API_LOCATION: '' });
    const fetchMock = respond(json({ ok: true }));

    await api('https://openmaps.example.test/wfs', {
      headers: { Authorization: 'Bearer smuggled' },
    });

    expect(authHeader(fetchMock.mock.calls[0]!)).toBeNull();
  });

  it('withholds the token from a host whose name only starts with the API host', async () => {
    const { api } = await loadClient({
      API_PATH: '/api',
      API_LOCATION: 'https://demi-api.example.com',
    });
    const fetchMock = respond(json({ ok: true }));

    await api('https://demi-api.example.com.evil.test/api/documents/1');

    expect(authHeader(fetchMock.mock.calls[0]!)).toBeNull();
  });

  it('withholds the token from a host whose name only ends with the API host', async () => {
    const { api } = await loadClient({
      API_PATH: '/api',
      API_LOCATION: 'https://demi-api.example.com',
    });
    const fetchMock = respond(json({ ok: true }));

    await api('https://evil-demi-api.example.com/api/documents/1');

    expect(authHeader(fetchMock.mock.calls[0]!)).toBeNull();
  });

  it('withholds the token from a same-origin path outside the API base', async () => {
    const { api } = await loadClient({ API_PATH: '/api', API_LOCATION: '' });
    const fetchMock = respond(json({ ok: true }));

    await api(`${window.location.origin}/data/invasive-species.json`);

    expect(authHeader(fetchMock.mock.calls[0]!)).toBeNull();
  });
});

describe('notifyBase', () => {
  const baseFor = async (location?: string) =>
    (await loadClient({ API_PATH: '/api', API_LOCATION: '', NOTIFY_API_LOCATION: location })).notifyBase();

  it('accepts an absolute https service', async () => {
    expect(await baseFor('https://notify.example.com/')).toBe('https://notify.example.com');
  });

  it('has no base when nothing is configured', async () => {
    expect(await baseFor()).toBeNull();
  });

  // A relative path is the Vite proxy. A build has no proxy, only this origin, which is the DEMI
  // API — and the notify screen sends a bearer token.
  it('accepts a relative path in a dev build only', async () => {
    expect(await baseFor('/notify-api')).toBe(`${window.location.origin}/notify-api`);

    vi.stubEnv('DEV', false);
    expect(await baseFor('/notify-api')).toBeNull();
    vi.unstubAllEnvs();
  });

  it('refuses an http service', async () => {
    expect(await baseFor('http://notify.example.com')).toBeNull();
  });
});

describe('401 handling', () => {
  it('refreshes once and replays the request', async () => {
    const { api } = await loadClient({ API_PATH: '/api', API_LOCATION: '' });
    getToken.mockReturnValueOnce('stale-token');
    const fetchMock = respond(json({ error: 'expired' }, 401), json({ ok: true }));

    await expect(api<{ ok: boolean }>('/documents/1')).resolves.toEqual({ ok: true });

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authHeader(fetchMock.mock.calls[1]!)).toBe('Bearer staff-token');
  });

  it('gives up after one replay', async () => {
    const { api, ApiError } = await loadClient({ API_PATH: '/api', API_LOCATION: '' });
    const fetchMock = respond(json({ error: 'no' }, 403), json({ error: 'still no' }, 403));

    await expect(api('/documents/1')).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('never refreshes for a third-party 401', async () => {
    const { api } = await loadClient({ API_PATH: '/api', API_LOCATION: '' });
    const fetchMock = respond(json({ error: 'nope' }, 401));

    await expect(api('https://openmaps.example.test/wfs')).rejects.toMatchObject({ status: 401 });

    expect(refreshToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The notify host opts into the bearer, but it is still not our API: its 401 is its own answer.
  it('never refreshes for a 401 from the opted-in notify host', async () => {
    const { api, notifyBase } = await loadClient({
      API_PATH: '/api',
      API_LOCATION: 'https://demi-api.example.com',
      NOTIFY_API_LOCATION: 'https://notify.example.com',
    });
    const fetchMock = respond(json({ error: 'nope' }, 401));

    await expect(api(`${notifyBase()}/subscriptions`, { bearerFor: notifyBase()! })).rejects.toMatchObject({
      status: 401,
    });

    expect(refreshToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives the replay a signal that has not already expired', async () => {
    const { api } = await loadClient({ API_PATH: '/api', API_LOCATION: '' });
    const fetchMock = respond(json({ error: 'expired' }, 401), json({ ok: true }));

    await expect(api<{ ok: boolean }>('/documents/1', { timeoutMs: 5000 })).resolves.toEqual({
      ok: true,
    });

    const first = signalOf(fetchMock.mock.calls[0]!);
    const replay = signalOf(fetchMock.mock.calls[1]!);
    expect(replay).not.toBe(first);
    expect(replay?.aborted).toBe(false);
  });
});

describe('ApiError', () => {
  it('reports the error the server sent', async () => {
    const { api } = await loadClient({ API_PATH: '/api', API_LOCATION: '' });
    respond(json({ error: 'pageSize above the cap' }, 400));

    await expect(api('/search?keywords=secret')).rejects.toThrow('pageSize above the cap');
  });

  // The message reaches telemetry; the body can carry the query that produced it and the URL can
  // carry the search terms. Callers that need either read the fields.
  it('keeps the body and the URL out of the message', async () => {
    const { api } = await loadClient({ API_PATH: '/api', API_LOCATION: '' });
    respond(new Response('stack trace mentioning secret-term', { status: 500 }));

    const error = (await api('/search?keywords=secret-term').catch((e: unknown) => e)) as Error;

    expect(error.message).toBe('Request failed (HTTP 500)');
    expect(error.message).not.toContain('secret-term');
  });

  it('keeps the status and body available to callers', async () => {
    const { api } = await loadClient({ API_PATH: '/api', API_LOCATION: '' });
    respond(new Response('the raw body', { status: 503 }));

    await expect(api('/documents/1')).rejects.toMatchObject({
      status: 503,
      body: 'the raw body',
    });
  });

  it('lets the first answer stand when the refresh fails', async () => {
    const { api } = await loadClient({ API_PATH: '/api', API_LOCATION: '' });
    refreshToken.mockRejectedValueOnce(new Error('session over'));
    const fetchMock = respond(json({ error: 'expired' }, 401));

    await expect(api('/documents/1')).rejects.toMatchObject({ status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
