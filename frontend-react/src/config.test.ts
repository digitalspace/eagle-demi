import { afterEach, describe, expect, it, vi } from 'vitest';

/** config.ts holds module state, so each test loads its own copy. */
async function loadConfig(env: Record<string, unknown>) {
  vi.resetModules();
  window.__env = env;
  return import('./config');
}

function answers(bodies: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const body = bodies[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__env;
});

describe('initConfig', () => {
  it('reads the public config document whether or not the config endpoint is on', async () => {
    const fetchMock = answers({ '/api/config/public': { CONTENT_SEARCH: true } });
    vi.stubGlobal('fetch', fetchMock);

    const { initConfig } = await loadConfig({ configEndpoint: false, API_PATH: '/api' });
    const merged = await initConfig();

    expect(merged['CONTENT_SEARCH']).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the config endpoint alone unless configEndpoint is exactly true', async () => {
    const fetchMock = answers({ '/api/config/public': {} });
    vi.stubGlobal('fetch', fetchMock);

    const { initConfig } = await loadConfig({ API_PATH: '/api' });
    await initConfig();

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/config/public']);
  });

  it('lets env.js win over the public document', async () => {
    vi.stubGlobal(
      'fetch',
      answers({ '/api/config/public': { ENVIRONMENT: 'prod', BANNER_COLOUR: 'green' } }),
    );

    const { initConfig } = await loadConfig({ API_PATH: '/api', ENVIRONMENT: 'test' });
    const merged = await initConfig();

    expect(merged.ENVIRONMENT).toBe('test');
    expect(merged.BANNER_COLOUR).toBe('green');
  });

  it('lets the config endpoint win over env.js', async () => {
    vi.stubGlobal(
      'fetch',
      answers({
        '/api/config/public': { ENVIRONMENT: 'public' },
        '/api/config': { ENVIRONMENT: 'live' },
      }),
    );

    const { initConfig } = await loadConfig({ API_PATH: '/api', configEndpoint: true, ENVIRONMENT: 'test' });

    expect((await initConfig()).ENVIRONMENT).toBe('live');
  });

  it('keeps the values already in hand when a document does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    const { initConfig, config } = await loadConfig({
      API_PATH: '/api',
      configEndpoint: true,
      ENVIRONMENT: 'test',
    });
    const merged = await initConfig();

    expect(merged.ENVIRONMENT).toBe('test');
    expect(config().ENVIRONMENT).toBe('test');
  });

  it('reads both documents under API_LOCATION when no API_PATH is set', async () => {
    const fetchMock = answers({ 'https://demi.example.test/api/config/public': { ok: true } });
    vi.stubGlobal('fetch', fetchMock);

    const { initConfig } = await loadConfig({ API_LOCATION: 'https://demi.example.test/' });
    await initConfig();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://demi.example.test/api/config/public');
  });
});

// The gate waits on these two reads, so a config endpoint that accepts the connection and then
// says nothing would otherwise hold the app on its skeleton forever.
describe('the config read budget', () => {
  it('gives both documents a deadline', async () => {
    const fetchMock = answers({ '/api/config/public': {}, '/api/config': {} });
    vi.stubGlobal('fetch', fetchMock);

    const { initConfig, CONFIG_TIMEOUT_MS } = await loadConfig({
      API_PATH: '/api',
      configEndpoint: true,
    });
    await initConfig();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(CONFIG_TIMEOUT_MS).toBe(5000);
  });

  it('falls through to the values already in place when a document never answers', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const budget = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(10));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
          }),
      ),
    );

    const { initConfig, CONFIG_TIMEOUT_MS } = await loadConfig({
      API_PATH: '/api',
      ENVIRONMENT: 'test',
    });
    const merged = await initConfig();

    expect(budget).toHaveBeenCalledWith(CONFIG_TIMEOUT_MS);
    expect(merged.ENVIRONMENT).toBe('test');
  });
});
