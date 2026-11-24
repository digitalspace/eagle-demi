import { config } from '../config';
import { getToken, refreshToken } from './keycloak';

/**
 * `message` is the server's `error` or the status, never the URL or raw body: it reaches
 * telemetry, and those can carry the query. Callers that need them read the fields.
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

/** What a failed request or mutation should read as on screen. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A non-empty string `field` from a JSON body, or null when the body has none. */
export function bodyString(body: string, field: string): string | null {
  try {
    const value = (JSON.parse(body) as Record<string, unknown>)[field];
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/** The `error` string a DEMI error body carries, or null when it has none. */
export function serverError(body: string): string | null {
  return bodyString(body, 'error');
}

/** The DEMI API base, prefix included. Empty API_LOCATION = same origin, through the dev proxy. */
function apiPath(): string {
  const { API_PATH = '/api', API_LOCATION } = config();
  const base = API_LOCATION || window.location.origin;
  return new URL(API_PATH, base).href.replace(/\/$/, '');
}

/**
 * The eagle-notify base: https, or a relative path in dev only (the Vite proxy). Anything else is
 * null, never resolved against this origin, which is the DEMI API and would get the bearer.
 */
export function notifyBase(): string | null {
  const location = config().NOTIFY_API_LOCATION?.trim();
  if (!location) return null;
  if (location.startsWith('/')) {
    return import.meta.env.DEV ? new URL(location, window.location.origin).href.replace(/\/$/, '') : null;
  }
  try {
    const url = new URL(location);
    return url.protocol === 'https:' ? url.href.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

/**
 * Origin equality plus a path prefix, never `url.includes(base)`: the base can fall back to '/api',
 * and a substring test would hand the bearer to any host containing it.
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

/** Only the DEMI API; eagle-notify is a different host and opts in through `bearerFor`. */
function isAllowedUrl(url: URL): boolean {
  return matchesBase(url, apiPath());
}

/** A JSON request body. */
export function jsonBody(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** The budget a read asks for by passing `timeoutMs`; a call that omits it has none. */
export const READ_TIMEOUT_MS = 5000;

export interface ApiInit extends RequestInit {
  /** Budget in ms. A fresh signal is made per attempt, so a replay is never born already aborted. */
  timeoutMs?: number;
  /**
   * Base outside the DEMI API that may get the bearer (eagle-notify). Only URLs inside it get the
   * token, so an opt-in cannot carry it to a URL that came from elsewhere.
   */
  bearerFor?: string;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const res = await request(path, init);
  // A 204 carries no body, and JSON.parse('') throws.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A list page and the total DEMI sends in `x-total-count`, which it does only for `count=true`. */
export interface ApiList<T> {
  rows: T[];
  total: number | null;
}

export async function apiList<T>(path: string, init: ApiInit = {}): Promise<ApiList<T>> {
  const res = await request(path, init);
  return { rows: (await res.json()) as T[], total: totalCount(res.headers.get('x-total-count')) };
}

/** Anything but a whole number reads as no total, so a bad header never shows as NaN or 0. */
function totalCount(header: string | null): number | null {
  return header !== null && /^\d+$/.test(header) ? Number(header) : null;
}

/** Sends with the bearer and one refresh-and-replay; a non-2xx answer throws `ApiError`. */
async function request(path: string, init: ApiInit): Promise<Response> {
  const { timeoutMs, bearerFor, ...rest } = init;
  const url = new URL(path.startsWith('/') ? apiPath() + path : path, window.location.origin);
  const allowed = isAllowedUrl(url);
  const attach = allowed || matchesBase(url, bearerFor ?? null);

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
  return res;
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
