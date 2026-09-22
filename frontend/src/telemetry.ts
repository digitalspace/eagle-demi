import type { ApplicationInsights, ITelemetryItem } from '@microsoft/applicationinsights-web';

/** Swapped in tests so no spec loads the real SDK. */
export type SdkLoader = () => Promise<typeof import('@microsoft/applicationinsights-web')>;

/** Errors raised before the SDK chunk lands are held, not dropped. */
const MAX_PENDING = 20;

let appInsights: ApplicationInsights | undefined;
let pending: { error: unknown; properties?: Record<string, string> }[] = [];

/** Hosts that may carry the correlation headers: this site, plus the API when it is on its own origin. */
export function correlationHosts(apiPath?: string): string[] {
  const hosts = [window.location.host];
  if (apiPath && /^https?:\/\//.test(apiPath)) {
    hosts.push(new URL(apiPath).host);
  }
  return hosts;
}

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

// Strips `?key=value...` and `#key=value...` runs (tokens, search terms). The fragment half matters
// because an OAuth response arrives there: `#code=…&session_state=…`. Needs `key=` after the `?` or
// `#` so prose question marks and `#main` anchors survive; no `:` stop, so ISO dates scrub whole
// even though a `file.js?v=1:42:9)` frame loses `:42:9`.
const QUERY_OR_FRAGMENT = /[?#][\w%.~-]+=[^\s)#'"]*/g;

function scrub(target: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    const value = target[field];
    if (typeof value === 'string') {
      target[field] = value.replace(QUERY_OR_FRAGMENT, '');
    }
  }
}

/** Stamps the cloud role, drops successful dependencies and cuts query strings off the rest. */
export function errorsOnly(role: string) {
  return (item: ITelemetryItem): boolean => {
    item.tags = item.tags || {};
    item.tags['ai.cloud.role'] = role;

    const data: Record<string, unknown> = item.baseData || {};
    if (item.baseType === 'RemoteDependencyData' && data['success'] !== false) {
      return false;
    }
    scrub(data, ['uri', 'target', 'name', 'message']);
    for (const exception of records(data['exceptions'])) {
      scrub(exception, ['message', 'stack']);
      for (const frame of records(exception['parsedStack'])) {
        scrub(frame, ['fileName', 'assembly']);
      }
    }
    return true;
  };
}

/**
 * Send browser errors to Application Insights. Nothing else leaves the page.
 * Returns false when no connection string is configured, which means telemetry stays off.
 */
export async function init(
  connectionString: string | undefined,
  role: string,
  hosts: string[],
  load: SdkLoader = () => import('@microsoft/applicationinsights-web')
): Promise<boolean> {
  if (!connectionString) return false;

  // A stale hashed chunk after a redeploy makes the dynamic import reject: caught here so
  // startup never sees an unhandled rejection, telemetry just stays off.
  try {
    const { ApplicationInsights } = await load();
    const started = new ApplicationInsights({
      config: {
        connectionString,
        enableCorsCorrelation: true,
        correlationHeaderDomains: hosts,
        enableAutoRouteTracking: false,
        enableUnhandledPromiseRejectionTracking: true,
        // Stops the SDK's config-sync plugin fetching js.monitor.azure.com on every load.
        extensionConfig: { AppInsightsCfgSyncPlugin: { cfgUrl: '', blkCdnCfg: true } }
      }
    });
    started.loadAppInsights();
    started.addTelemetryInitializer(errorsOnly(role));
    appInsights = started;
  } catch {
    return false;
  }

  const held = pending;
  pending = [];
  for (const item of held) {
    trackException(item.error, item.properties);
  }
  return true;
}

export function trackException(error: unknown, properties?: Record<string, string>): void {
  if (!appInsights) {
    if (pending.length < MAX_PENDING) pending.push({ error, properties });
    return;
  }
  appInsights.trackException({
    exception: error instanceof Error ? error : new Error(String(error)),
    properties
  });
}
