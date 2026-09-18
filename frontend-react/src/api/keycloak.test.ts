import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config';

const keycloak = vi.hoisted(() => ({
  constructed: vi.fn(),
  init: vi.fn<(options: Record<string, unknown>) => Promise<boolean>>(async () => true),
  login: vi.fn(),
  logout: vi.fn(),
  clearToken: vi.fn(),
  updateToken: vi.fn<(minValidity: number) => Promise<boolean>>(async () => true),
  token: 'staff-token' as string | undefined,
  idToken: 'id-token' as string | undefined,
  tokenParsed: { realm_access: { roles: ['staff'] }, preferred_username: 'idir\\jane' } as unknown,
}));

vi.mock('keycloak-js', () => ({
  default: class {
    constructor() {
      keycloak.constructed();
    }
    init = keycloak.init;
    login = keycloak.login;
    logout = keycloak.logout;
    clearToken = keycloak.clearToken;
    updateToken = keycloak.updateToken;
    get token() {
      return keycloak.token;
    }
    get idToken() {
      return keycloak.idToken;
    }
    get tokenParsed() {
      return keycloak.tokenParsed;
    }
  },
}));

const ENV: AppConfig = {
  API_PATH: '/api',
  KEYCLOAK_ENABLED: true,
  KEYCLOAK_URL: 'https://test.loginproxy.gov.bc.ca/auth',
  KEYCLOAK_REALM: 'eao-epic',
  KEYCLOAK_CLIENT_ID: 'eagle-admin-console',
};

async function loadKeycloak(env: AppConfig = ENV) {
  vi.resetModules();
  window.__env = env;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const { initConfig } = await import('../config');
  await initConfig();
  return import('./keycloak');
}

const initOptions = () => keycloak.init.mock.calls[0]![0];

beforeEach(() => {
  keycloak.init.mockResolvedValue(true);
  keycloak.updateToken.mockResolvedValue(true);
  keycloak.token = 'staff-token';
  keycloak.idToken = 'id-token';
  keycloak.tokenParsed = { realm_access: { roles: ['staff'] }, preferred_username: 'idir\\jane' };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  delete window.__env;
});

describe('initKeycloak', () => {
  // A first visit has nothing to resume. The silent iframe it used to try needs third-party
  // cookies, which browsers block by default, so it only ever cost a round trip before the
  // sign-in screen the visitor was getting anyway.
  it('builds no client at all on a first visit', async () => {
    const { initKeycloak, isAuthenticated } = await loadKeycloak();

    expect(await initKeycloak()).toBe(false);

    expect(keycloak.constructed).not.toHaveBeenCalled();
    expect(keycloak.init).not.toHaveBeenCalled();
    expect(isAuthenticated()).toBe(false);
  });

  it('redirects to the identity provider when a login is remembered', async () => {
    localStorage.setItem('isLoggedIn', 'true');
    const { initKeycloak } = await loadKeycloak();

    await initKeycloak();

    expect(initOptions()['onLoad']).toBe('login-required');
    expect(initOptions()['silentCheckSsoRedirectUri']).toBe(
      window.location.origin + '/silent-check-sso.html',
    );
    expect(initOptions()['pkceMethod']).toBe('S256');
    expect(initOptions()['scope']).toBe('openid roles');
  });

  it('checks quietly while handling the callback of a remembered login', async () => {
    localStorage.setItem('isLoggedIn', 'true');
    window.location.hash = '#code=abc123&state=xyz';
    const { initKeycloak } = await loadKeycloak();

    await initKeycloak();
    window.location.hash = '';

    expect(initOptions()['onLoad']).toBe('check-sso');
  });

  it('strips the OAuth response out of the hash and leaves the path and query alone', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    window.location.hash = '#state=abc&session_state=xyz&code=def';
    const { initKeycloak } = await loadKeycloak();

    await initKeycloak();

    expect(replaceState).toHaveBeenCalledWith(
      {},
      document.title,
      window.location.pathname + window.location.search,
    );
    expect(window.location.hash).toBe('');
    replaceState.mockRestore();
  });

  it('remembers a login that worked, so the next visit goes straight to the provider', async () => {
    window.location.hash = '#code=abc123&state=xyz';
    const { initKeycloak } = await loadKeycloak();

    await initKeycloak();
    window.location.hash = '';

    expect(localStorage.getItem('isLoggedIn')).toBe('true');
    expect(sessionStorage.getItem('isLoggedIn')).toBe('true');
  });

  it('forgets the login when the session is gone', async () => {
    localStorage.setItem('isLoggedIn', 'true');
    sessionStorage.setItem('isLoggedIn', 'true');
    keycloak.init.mockResolvedValue(false);
    const { initKeycloak, isAuthenticated } = await loadKeycloak();

    expect(await initKeycloak()).toBe(false);

    expect(localStorage.getItem('isLoggedIn')).toBeNull();
    expect(sessionStorage.getItem('isLoggedIn')).toBeNull();
    expect(isAuthenticated()).toBe(false);
  });

  it('runs signed out when the identity provider answered with an error', async () => {
    window.location.hash = '#error=login_required';
    const { initKeycloak, isAuthenticated } = await loadKeycloak();

    expect(await initKeycloak()).toBe(false);
    window.location.hash = '';

    expect(keycloak.init).not.toHaveBeenCalled();
    expect(isAuthenticated()).toBe(false);
  });

  it('settles without Keycloak when auth is turned off', async () => {
    const { initKeycloak, isAuthenticated } = await loadKeycloak({ ...ENV, KEYCLOAK_ENABLED: false });

    expect(await initKeycloak()).toBe(false);

    expect(keycloak.constructed).not.toHaveBeenCalled();
    expect(isAuthenticated()).toBe(false);
  });
});

describe('login', () => {
  // The first visit leaves no client behind, so the sign-in button is what builds one.
  it('builds a client and redirects when a first visitor asks to sign in', async () => {
    const { initKeycloak, login } = await loadKeycloak();
    await initKeycloak();

    login();

    expect(keycloak.constructed).toHaveBeenCalledTimes(1);
    expect(initOptions()['onLoad']).toBe('login-required');
    expect(keycloak.login).not.toHaveBeenCalled();
  });

  it('reuses the client a settled session already built', async () => {
    localStorage.setItem('isLoggedIn', 'true');
    const { initKeycloak, login } = await loadKeycloak();
    await initKeycloak();

    login();

    expect(keycloak.constructed).toHaveBeenCalledTimes(1);
    expect(keycloak.login).toHaveBeenCalledWith({
      redirectUri: window.location.origin + window.location.pathname,
    });
  });
});

describe('hasStaffRole', () => {
  it('accepts an EPIC staff role', async () => {
    keycloak.tokenParsed = { realm_access: { roles: ['demi-admin'] } };
    localStorage.setItem('isLoggedIn', 'true');
    const { initKeycloak, hasStaffRole } = await loadKeycloak();

    await initKeycloak();

    expect(hasStaffRole()).toBe(true);
  });

  it('refuses an account that carries no staff role', async () => {
    keycloak.tokenParsed = { realm_access: { roles: ['public-user'] } };
    localStorage.setItem('isLoggedIn', 'true');
    const { initKeycloak, hasStaffRole, isAuthenticated } = await loadKeycloak();

    await initKeycloak();

    expect(isAuthenticated()).toBe(true);
    expect(hasStaffRole()).toBe(false);
  });
});

describe('getVisibleRoles', () => {
  it('drops the roles Keycloak gives every account', async () => {
    keycloak.tokenParsed = {
      realm_access: { roles: ['staff', 'default-roles-eao-epic', 'offline_access', 'uma_authorization'] },
    };
    localStorage.setItem('isLoggedIn', 'true');
    const { initKeycloak, getVisibleRoles } = await loadKeycloak();

    await initKeycloak();

    expect(getVisibleRoles()).toEqual(['staff']);
  });
});

/** A settled, signed-in session: the only state a refresh can fail out of. */
async function signedIn() {
  localStorage.setItem('isLoggedIn', 'true');
  const kc = await loadKeycloak();
  await kc.initKeycloak();
  return kc;
}

describe('losing the session', () => {
  it('tells its subscribers, so the gate can drop to sign-in', async () => {
    const { refreshToken, subscribeAuth, getAuthSnapshot } = await signedIn();
    const changed = vi.fn();
    subscribeAuth(changed);
    keycloak.updateToken.mockRejectedValue(new Error('refresh token expired'));

    await expect(refreshToken()).rejects.toThrow('refresh token expired');

    expect(changed).toHaveBeenCalled();
    expect(getAuthSnapshot().authenticated).toBe(false);
  });

  it('stops handing out a token the API has already started refusing', async () => {
    const { refreshToken, getToken, isAuthenticated, getUserName, getVisibleRoles } =
      await signedIn();
    expect(getToken()).toBe('staff-token');
    keycloak.updateToken.mockRejectedValue(new Error('refresh token expired'));

    await expect(refreshToken()).rejects.toThrow();

    expect(getToken()).toBeUndefined();
    expect(isAuthenticated()).toBe(false);
    expect(getUserName()).toBe('');
    expect(getVisibleRoles()).toEqual([]);
  });

  it('forgets the remembered login, so the next visit does not redirect', async () => {
    const { refreshToken } = await signedIn();
    keycloak.updateToken.mockRejectedValue(new Error('refresh token expired'));

    await expect(refreshToken()).rejects.toThrow();

    expect(localStorage.getItem('isLoggedIn')).toBeNull();
    expect(sessionStorage.getItem('isLoggedIn')).toBeNull();
  });

  // One snapshot identity per state, which is what stops useSyncExternalStore looping.
  it('keeps one snapshot identity until something changes', async () => {
    const { getAuthSnapshot } = await signedIn();

    expect(getAuthSnapshot()).toBe(getAuthSnapshot());
  });
});

describe('refresh sharing', () => {
  it('sends one request when two callers ask at once', async () => {
    const { refreshToken } = await signedIn();
    keycloak.updateToken.mockClear();

    await Promise.all([refreshToken(), refreshToken()]);

    expect(keycloak.updateToken).toHaveBeenCalledTimes(1);
  });

  // The keep-fresh tick used to call updateToken directly, so a tick landing mid-401 started a
  // second refresh against the same one-use refresh token.
  it('lets the keep-fresh tick join a refresh already in flight', async () => {
    vi.useFakeTimers();
    try {
      const { refreshToken } = await signedIn();
      keycloak.updateToken.mockClear();
      let settle: (refreshed: boolean) => void = () => undefined;
      keycloak.updateToken.mockReturnValue(
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
      );

      const inFlight = refreshToken();
      await vi.advanceTimersByTimeAsync(60_000);
      settle(true);
      await inFlight;

      expect(keycloak.updateToken).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('signs the store out when the keep-fresh tick fails', async () => {
    vi.useFakeTimers();
    try {
      const { isAuthenticated } = await signedIn();
      expect(isAuthenticated()).toBe(true);
      keycloak.updateToken.mockRejectedValue(new Error('refresh token expired'));

      await vi.advanceTimersByTimeAsync(60_000);

      expect(isAuthenticated()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('logoutUrl', () => {
  it('carries the parameters this realm acts on', async () => {
    const { logoutUrl } = await signedIn();

    const url = new URL(logoutUrl()!);

    expect(url.pathname).toBe('/auth/realms/eao-epic/protocol/openid-connect/logout');
    expect(url.searchParams.get('client_id')).toBe('eagle-admin-console');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(window.location.origin);
    expect(url.searchParams.get('id_token_hint')).toBe('id-token');
  });

  // An expired hint is a 400 from Keycloak, so it goes only when a token is in hand.
  it('leaves the hint out when no id token is held', async () => {
    keycloak.idToken = undefined;
    const { logoutUrl } = await signedIn();

    expect(new URL(logoutUrl()!).searchParams.has('id_token_hint')).toBe(false);
  });

  it('has no URL to offer when no client was ever built', async () => {
    const { logoutUrl } = await loadKeycloak();

    expect(logoutUrl()).toBeNull();
  });
});

describe('logout', () => {
  it('signs the store out before it navigates anywhere', async () => {
    const { logout, isAuthenticated, getToken } = await signedIn();

    logout();

    expect(isAuthenticated()).toBe(false);
    expect(getToken()).toBeUndefined();
    expect(localStorage.getItem('isLoggedIn')).toBeNull();
    expect(keycloak.clearToken).toHaveBeenCalled();
  });

  // No client means no end-session endpoint to visit. Reload anyway, so privileged rows still
  // resident in memory go; this used to return silently and the button appeared to do nothing.
  it('reloads when there is no client to end a session with', async () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      origin: window.location.origin,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: '',
      reload,
    } as unknown as Location);
    const { logout, isAuthenticated } = await loadKeycloak();

    logout();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(isAuthenticated()).toBe(false);
  });
});
