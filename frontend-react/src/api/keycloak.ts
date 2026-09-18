import Keycloak from 'keycloak-js';
import { config } from '../config';

const STAFF_ROLES = ['sysadmin', 'staff', 'demi-admin'];

const KEYCLOAK_BUILTIN_ROLES = ['default-roles-eao-epic', 'offline_access', 'uma_authorization'];

/** Set on both storages so a remembered login survives a new tab as well as a reload. */
const REMEMBER_KEY = 'isLoggedIn';

/** Keycloak's own init can hang; the app must still reach its gate. */
const INIT_TIMEOUT_MS = 15_000;

const REFRESH_INTERVAL_MS = 60_000;

/** Minimum seconds of token life the 401 path and the keep-fresh tick each insist on. */
const REPLAY_MIN_VALIDITY = 30;
const KEEP_FRESH_MIN_VALIDITY = 70;

export interface AuthState {
  authenticated: boolean;
  userName: string;
  roles: string[];
}

const SIGNED_OUT: AuthState = { authenticated: false, userName: '', roles: [] };

let client: Keycloak | null = null;
let auth: AuthState = SIGNED_OUT;
let initPromise: Promise<boolean> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Auth state is a store, not a value read once: a refresh can fail at any moment and the gate,
 * the account menu and every screen have to see that happen. `useSyncExternalStore` in
 * SessionProvider is the only consumer.
 */
const listeners = new Set<() => void>();

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Referentially stable between changes, which is what useSyncExternalStore requires. */
export function getAuthSnapshot(): AuthState {
  return auth;
}

function setAuth(next: AuthState): void {
  auth = next;
  for (const listener of [...listeners]) listener();
}

/** False turns the whole Keycloak leg off, for local development against a mock API. */
export function authEnabled(): boolean {
  return config().KEYCLOAK_ENABLED !== false;
}

export function isAuthenticated(): boolean {
  return auth.authenticated;
}

export function getUserName(): string {
  return auth.userName;
}

/** Gated on the session, so a failed refresh stops handing out a token the API already refuses. */
export function getToken(): string | undefined {
  return auth.authenticated ? client?.token : undefined;
}

/** Realm roles worth showing a person: the token's list without Keycloak's own boilerplate. */
export function getVisibleRoles(): string[] {
  return auth.roles.filter((role) => !KEYCLOAK_BUILTIN_ROLES.includes(role));
}

/** The fallback answer to "is this a staffer", used only when `GET /me` cannot say. */
export function hasStaffRole(): boolean {
  return auth.roles.some((role) => STAFF_ROLES.includes(role));
}

/**
 * Settle the Keycloak session. Resolves whether or not a session was found; the caller decides
 * what to do about it. Called once — a second call returns the first result.
 */
export function initKeycloak(): Promise<boolean> {
  initPromise ??= start();
  return initPromise;
}

async function start(): Promise<boolean> {
  if (!authEnabled()) {
    setAuth(SIGNED_OUT);
    return false;
  }

  // Path routing never reads or writes location.hash, so anything there is the OAuth response.
  const oauthParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));

  if (oauthParams.has('error')) {
    console.warn('[keycloak] OAuth error in the URL; cleaning it and running signed out.');
    cleanUrl();
    forget();
    return false;
  }

  const isOAuthCallback = oauthParams.has('code');

  // A first visit with nothing to resume: no client, no init, no redirect. The sign-in screen is
  // the answer, and `login()` builds the client when the visitor asks for one.
  if (!isOAuthCallback && !remembered()) {
    setAuth(SIGNED_OUT);
    return false;
  }

  client = newClient();

  // keycloak-js processes a valid callback code before it even looks at onLoad, but if that
  // processing fails onLoad is what decides what happens next, so it is always set.
  // A remembered login uses 'login-required': a full redirect to the IdP, which holds a
  // first-party cookie and bounces straight back with a code, no prompt. 'check-sso' does the same
  // through a hidden iframe, which needs third-party cookies that browsers now block by default,
  // so it is left for the callback, where the code in hand is what settles the session.
  const onLoad = remembered() && !isOAuthCallback ? 'login-required' : 'check-sso';

  let authenticated = false;
  try {
    authenticated = await Promise.race([
      client.init({
        onLoad,
        checkLoginIframe: false,
        pkceMethod: 'S256',
        scope: 'openid roles',
        redirectUri: window.location.origin + window.location.pathname,
        silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html',
      }),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('Keycloak initialization timeout')), INIT_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    console.warn('[keycloak] init failed; running signed out:', e);
    authenticated = false;
  }

  cleanUrl();

  if (!authenticated) {
    forget();
    setAuth(SIGNED_OUT);
    return false;
  }

  remember();
  const claims = client.tokenParsed;
  setAuth({
    authenticated: true,
    roles: claims?.realm_access?.roles ?? [],
    userName:
      (claims?.['preferred_username'] as string) || (claims?.['name'] as string) || 'Staff User',
  });
  keepTokenFresh();
  return true;
}

function newClient(): Keycloak {
  const c = config();
  return new Keycloak({
    url: c.KEYCLOAK_URL ?? '',
    realm: c.KEYCLOAK_REALM ?? '',
    clientId: c.KEYCLOAK_CLIENT_ID ?? '',
  });
}

/** The only route to a login: a first visit never builds a client until this is called. */
export function login(): void {
  const redirectUri = window.location.origin + window.location.pathname;
  if (client) {
    void client.login({ redirectUri });
    return;
  }

  client = newClient();
  void client
    .init({
      onLoad: 'login-required',
      checkLoginIframe: false,
      pkceMethod: 'S256',
      scope: 'openid roles',
      redirectUri,
    })
    .catch((err: unknown) => {
      console.error('[keycloak] explicit login init failed:', err);
      cleanUrl();
    });
}

/**
 * The end-session URL for this session, or null when there is no client to end.
 *
 * `client_id` + `post_logout_redirect_uri` is the pair this realm acts on; a bare `redirect_uri`
 * is ignored and leaves the browser on Keycloak's "Do you want to log out?" page. An expired
 * `id_token_hint` is a 400, so the hint goes only when a token is in hand. Exported so it can be
 * read back without a test navigating the runner away.
 */
export function logoutUrl(): string | null {
  if (!client) return null;
  const c = config();
  const params = new URLSearchParams({
    client_id: c.KEYCLOAK_CLIENT_ID || 'eagle-admin-console',
    post_logout_redirect_uri: window.location.origin,
  });
  if (client.idToken) params.set('id_token_hint', client.idToken);
  return `${c.KEYCLOAK_URL}/realms/${c.KEYCLOAK_REALM}/protocol/openid-connect/logout?${params}`;
}

export function logout(): void {
  // Before the redirect, not left to it: a null client or a blocked navigation used to leave the
  // header reading "signed in" over a session that no longer existed.
  clearAuthState();

  const kc = client;
  // Read before clearToken(), which drops the id token the hint is built from.
  const url = logoutUrl();

  if (kc && url) {
    kc.clearToken();
    window.location.href = url;
    return;
  }

  // No client to end a session with, but the store above is already signed out, so reload to drop
  // any privileged rows still resident in memory.
  window.location.reload();
}

/**
 * Refresh the access token, sharing one request across every caller — the 401 replay and the
 * keep-fresh tick both land here, so a tick mid-401 cannot start a second refresh. A failed
 * refresh means the session is over: say so, rather than leaving the app claiming a live one over
 * data the API has already started refusing.
 */
let refreshing: Promise<boolean> | null = null;

export function refreshToken(minValidity = REPLAY_MIN_VALIDITY): Promise<boolean> {
  if (!client) return Promise.resolve(false);
  refreshing ??= client
    .updateToken(minValidity)
    .then((refreshed) => {
      refreshing = null;
      return refreshed;
    })
    .catch((err: unknown) => {
      refreshing = null;
      console.warn('[keycloak] token refresh failed; session over:', err);
      clearAuthState();
      throw err;
    });
  return refreshing;
}

/** Refresh ahead of expiry so a 401 never starts the session-over path. */
function keepTokenFresh(): void {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    // Rejection is handled inside refreshToken(); this only keeps it off the unhandled path.
    void refreshToken(KEEP_FRESH_MIN_VALIDITY).catch(() => undefined);
  }, REFRESH_INTERVAL_MS);
}

function clearAuthState(): void {
  clearInterval(refreshTimer);
  refreshTimer = undefined;
  forget();
  setAuth(SIGNED_OUT);
}

function remembered(): boolean {
  return (
    sessionStorage.getItem(REMEMBER_KEY) === 'true' || localStorage.getItem(REMEMBER_KEY) === 'true'
  );
}

function remember(): void {
  sessionStorage.setItem(REMEMBER_KEY, 'true');
  localStorage.setItem(REMEMBER_KEY, 'true');
}

function forget(): void {
  sessionStorage.removeItem(REMEMBER_KEY);
  localStorage.removeItem(REMEMBER_KEY);
}

function cleanUrl(): void {
  window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
}
