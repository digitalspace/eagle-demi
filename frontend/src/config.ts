export interface AppConfig {
  configEndpoint?: boolean;
  ENVIRONMENT?: string;
  API_LOCATION?: string;
  API_PATH?: string;
  USE_MOCK_DATA?: boolean;
  KEYCLOAK_CLIENT_ID?: string;
  KEYCLOAK_URL?: string;
  KEYCLOAK_REALM?: string;
  KEYCLOAK_ENABLED?: boolean;
  REDIRECT_KEY?: string;
  BANNER_COLOUR?: string;
  /** Application Insights connection string. Empty means no browser telemetry. */
  APPINSIGHTS_CONNECTION_STRING?: string;
  /** eagle-notify's base: the `/notify-api` dev proxy path locally, its own origin when deployed. */
  NOTIFY_API_LOCATION?: string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __env?: AppConfig;
  }
}

let configuration: AppConfig = {};

/**
 * Read the two config documents and merge them under window.__env.
 *
 * The public document is the feature-flag mirror the public site boots on. It is unauthenticated
 * and carries no API location, so it is read whichever way this app is configured, and it sits
 * under window.__env: a key this app sets for itself still wins. A failed read leaves the values
 * already in place rather than taking the app down.
 */
export async function initConfig(): Promise<AppConfig> {
  configuration = { ...(window.__env ?? {}) };
  const base = apiBase();

  const [publicConfig, liveConfig] = await Promise.all([
    load(`${base}/config/public`),
    configuration.configEndpoint === true ? load(`${base}/config`) : Promise.resolve(null),
  ]);

  configuration = { ...publicConfig, ...configuration, ...liveConfig };
  return configuration;
}

export function config(): AppConfig {
  return configuration;
}

/** Where both config documents live, given whatever base the page was booted with. */
function apiBase(): string {
  if (configuration.API_PATH) {
    return configuration.API_PATH.replace(/\/$/, '');
  }
  if (configuration.API_LOCATION) {
    return `${configuration.API_LOCATION.replace(/\/$/, '')}/api`;
  }
  return '/api';
}

/** Budget per config read. The gate waits on these, so a hung endpoint must not hold the app shut. */
export const CONFIG_TIMEOUT_MS = 5000;

async function load(url: string): Promise<AppConfig | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as AppConfig;
  } catch (e) {
    console.warn(`[config] ${url} did not answer, falling back to env.js:`, e);
    return null;
  }
}
