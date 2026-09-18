import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AppConfig } from './config';

const keycloak = vi.hoisted(() => ({
  constructed: vi.fn(),
  init: vi.fn<() => Promise<boolean>>(async () => true),
  login: vi.fn(),
  logout: vi.fn(),
  updateToken: vi.fn(async () => true),
  tokenParsed: { realm_access: { roles: ['staff'] } } as unknown,
}));

vi.mock('keycloak-js', () => ({
  default: class {
    constructor() {
      keycloak.constructed();
    }
    init = keycloak.init;
    login = keycloak.login;
    logout = keycloak.logout;
    updateToken = keycloak.updateToken;
    token = 'staff-token';
    get tokenParsed() {
      return keycloak.tokenParsed;
    }
  },
}));

const ENV: AppConfig = {
  API_PATH: '/api',
  ENVIRONMENT: 'test',
  KEYCLOAK_ENABLED: true,
  KEYCLOAK_REALM: 'eao-epic',
};

/** Answers `/me` — and the config reads before it — with one payload. */
const answer = (body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );

async function renderApp(env: AppConfig = ENV) {
  vi.resetModules();
  window.__env = env;
  if (!vi.isMockFunction(globalThis.fetch)) answer({});
  const { initConfig } = await import('./config');
  await initConfig();
  const { App } = await import('./App');
  render(<App />);
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  delete window.__env;
});

describe('the auth gate', () => {
  it('holds the shell shape while the session is still being checked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).endsWith('/me')
          ? new Promise<Response>(() => undefined)
          : new Response('{}', { status: 200 }),
      ),
    );

    await renderApp();

    expect(screen.getByText('Checking your session…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  // A first visit has nothing to resume, so it costs no round trip to the identity provider, and
  // no round trip to /me either — that endpoint needs a bearer token this visitor does not have.
  it('offers a sign in on a first visit without touching Keycloak', async () => {
    const fetchSpy = vi.fn(async (_url: unknown) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await renderApp();

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Keycloak realm eao-epic')).toBeInTheDocument();
    expect(keycloak.constructed).not.toHaveBeenCalled();
    expect(keycloak.init).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).endsWith('/me'))).toBe(false);
  });

  it('explains the refusal when the account carries no staff role', async () => {
    localStorage.setItem('isLoggedIn', 'true');
    keycloak.init.mockResolvedValue(true);
    answer({ level: 2, staffUi: false });

    await renderApp();

    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByText(/carries no EPIC staff role/)).toBeInTheDocument();
  });

  it('shows the app to a signed-in staff account', async () => {
    localStorage.setItem('isLoggedIn', 'true');
    keycloak.init.mockResolvedValue(true);
    answer({ level: 1, staffUi: true });

    await renderApp();

    expect(await screen.findByRole('navigation', { name: 'DEMI' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('opens the app with auth turned off, for local development', async () => {
    await renderApp({ ...ENV, KEYCLOAK_ENABLED: false });

    expect(await screen.findByRole('navigation', { name: 'DEMI' })).toBeInTheDocument();
    expect(keycloak.init).not.toHaveBeenCalled();
  });
});
