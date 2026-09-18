import { config } from '../config';
import { getToken, refreshToken } from './keycloak';

/**
 * The server's own `error` when it sent one, else the status alone — as api-request.ts does.
 * Neither the URL nor the raw body goes in `message`, because a message reaches telemetry and an
 * error body can carry the query that produced it. Callers that need either read the fields.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(serverError(body) ?? `Request failed (HTTP ${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function serverError(body: string): string | null {
  try {
    const { error } = JSON.parse(body) as { error?: unknown };
    return typeof error === 'string' && error ? error : null;
  } catch {
    return null;
  }
}

/** The DEMI API base, prefix included. Empty API_LOCATION = same origin, through the dev proxy. */
export function apiPath(): string {
  const { API_PATH = '/api', API_LOCATION } = config();
  const base = API_LOCATION || window.location.origin;
  return new URL(API_PATH, base).href.replace(/\/$/, '');
}

/** The eagle-notify base, or null when it is unset or unparseable. */
export function notifyBase(): string | null {
  const location = config().NOTIFY_API_LOCATION;
  if (!location) return null;
  try {
    return new URL(location, window.location.origin).href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Is this URL one of ours?
 *
 * Origin equality plus a path-prefix test, never `url.includes(base)`: that substring test is a
 * credential-leak primitive, because the base falls back to '/api' and any third-party host
 * containing those characters would then be handed the user's bearer token.
 */
function matchesBase(url: URL, base: string | null): boolean {
  if (!base) return false;
  try {
    const baseUrl = new URL(base, window.location.origin);
    if (url.origin !== baseUrl.origin) return false;
    const basePath = baseUrl.pathname.replace(/\/$/, '');
    return url.pathname === basePath || url.pathname.startsWith(basePath + '/');
  } catch {
    return false;
  }
}

/** Only the DEMI API, as Angular's `isApiUrl`. eagle-notify is a different host and opts in. */
export function isAllowedUrl(url: URL): boolean {
  return matchesBase(url, apiPath());
}

/** A JSON request body. */
export function jsonBody(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export interface ApiInit extends RequestInit {
  /** Budget in ms. A fresh signal is made per attempt, so a replay is never born already aborted. */
  timeoutMs?: number;
  /** Send the bearer to a host outside the DEMI API, as the notify screen does by hand. */
  bearer?: boolean;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const { timeoutMs, bearer = false, ...rest } = init;
  const url = new URL(path.startsWith('/') ? apiPath() + path : path, window.location.origin);
  const allowed = isAllowedUrl(url);
  const attach = allowed || bearer;

  const send = () =>
    fetch(url, {
      ...rest,
      headers: withToken(rest, attach),
      signal: signalFor(rest.signal, timeoutMs),
    });

  let res = await send();

  // Only our own API gets a refresh and a replay. A 401 from anywhere else must never trigger a
  // token refresh, let alone a second request carrying a fresh token.
  if (allowed && (res.status === 401 || res.status === 403)) {
    try {
      await refreshToken();
      res = await send();
    } catch {
      // Refresh failed: the first response stands.
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, await res.text().catch(() => ''));
  }
  // A 204 carries no body, and JSON.parse('') throws.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A signal per attempt: one `AbortSignal.timeout` reused across a replay is already spent. */
function signalFor(signal: AbortSignal | null | undefined, timeoutMs?: number): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal ?? undefined;
  const budget = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, budget]) : budget;
}

function withToken(init: RequestInit, attach: boolean): Headers {
  const headers = new Headers(init.headers);
  if (!attach) {
    // A caller-supplied header would otherwise reach a host this client never vouched for.
    headers.delete('Authorization');
    return headers;
  }
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}
