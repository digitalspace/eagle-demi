import Keycloak from 'keycloak-js';
import { config } from '../config';
import { boundaryCache } from './boundaries';
import { clearPendingLasso } from '../map/pending-lasso';

export const STAFF_ROLES = ['sysadmin', 'staff', 'demi-admin'];

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

/** A store, not a value read once: a refresh can fail at any moment and every screen must see it.
 * Read only through `useSyncExternalStore` in SessionProvider. */
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

/** Claims the account, sessions and short-links screens read straight off the access token. */
export interface SessionClaims {
  /** Keycloak's own session id, falling back to the token's `sid`. '' when there is neither. */
  sessionId: string;
  preferredUsername: string;
  name?: string;
  email?: string;
  idirUsername?: string;
  groups?: string[];
  issuedAt?: number;
  expiresAt?: number;
}

/** Null when signed out, so nothing stale is rendered. */
export function getSessionClaims(): SessionClaims | null {
  const claims = auth.authenticated ? client?.tokenParsed : undefined;
  if (!claims) return null;
  return {
    sessionId: client?.sessionId || (claims['sid'] as string) || '',
    preferredUsername: (claims['preferred_username'] as string) || '',
    name: claims['name'] as string | undefined,
    email: claims['email'] as string | undefined,
    idirUsername: claims['idir_username'] as string | undefined,
    groups: claims['groups'] as string[] | undefined,
    issuedAt: claims.iat,
    expiresAt: claims.exp,
  };
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

  // 'login-required' redirects to the IdP, whose first-party cookie bounces straight back with a code;
  // 'check-sso' needs third-party cookies browsers block, so it is kept for the callback only.
  const onLoad = remembered() && !isOAuthCallback ? 'login-required' : 'check-sso';

  let authenticated: boolean;
  try {
    authenticated = await Promise.race([
      client.init({
        onLoad,
        checkLoginIframe: false,
        pkceMethod: 'S256',
        scope: 'openid roles',
        redirectUri: returnUri(),
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
  // Before the store updates: the screens that read cached rows render off the change below.
  boundaryCache.setOwner((claims?.['preferred_username'] as string) || '');
  setAuth({
    authenticated: true,
    roles: claims?.realm_access?.roles ?? [],
    userName:
      (claims?.['preferred_username'] as string) || (claims?.['name'] as string) || 'Staff User',
  });
  keepTokenFresh();
  return true;
}

/** Return address after sign-in: this page and its query string, so `?view=list` survives. */
const returnUri = () => window.location.origin + window.location.pathname + window.location.search;

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
  const redirectUri = returnUri();
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

/** End-session URL, or null with no client. The realm ignores a bare `redirect_uri`, so it gets
 * `client_id` + `post_logout_redirect_uri`; an expired `id_token_hint` is a 400, so sent only when held. */
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
  // Before the redirect: a null client or a blocked navigation must not leave the header signed in.
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

/** One shared refresh for the 401 replay and the keep-fresh tick, so they never race.
 * A failed refresh ends the session in the store too, since the API already refuses it. */
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

/** Sign-out and session-over alike: nothing the last session could read stays behind for the next. */
function clearAuthState(): void {
  clearInterval(refreshTimer);
  refreshTimer = undefined;
  forget();
  boundaryCache.clear();
  boundaryCache.setOwner('');
  clearPendingLasso();
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
