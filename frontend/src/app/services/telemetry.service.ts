import { Injectable } from '@angular/core';
import type { ApplicationInsights, ITelemetryItem } from '@microsoft/applicationinsights-web';

/** Swapped in tests so no spec loads the real SDK. */
export type SdkLoader = () => Promise<typeof import('@microsoft/applicationinsights-web')>;

/** Errors raised before the SDK chunk lands are held, not dropped. */
const MAX_PENDING = 20;

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

/**
 * Query strings can carry tokens, so `?key=value&key=value...` goes, colons in the value included
 * (an ISO timestamp would otherwise truncate the match at its first `:`). Requires `key=` after `?`
 * so a stray `?` in prose survives. Cost: a stack frame URL with a query loses its trailing `:line:col`
 * too — parsedStack keeps those in separate fields, so nothing is lost there.
 */
function scrub(target: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    const value = target[field];
    if (typeof value === 'string') {
      target[field] = value.replace(/\?[\w%.~-]+=[^\s)#'"]*/g, '');
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

/** Browser errors to Application Insights. Nothing else leaves the page. */
@Injectable({ providedIn: 'root' })
export class TelemetryService {
  private appInsights?: ApplicationInsights;
  private pending: { error: unknown; properties?: Record<string, string> }[] = [];

  /** Returns false when no connection string is configured, which means telemetry stays off. */
  async init(
    connectionString: string | undefined,
    role: string,
    hosts: string[],
    load: SdkLoader = () => import('@microsoft/applicationinsights-web')
  ): Promise<boolean> {
    if (!connectionString) {
      return false;
    }
    let appInsights: ApplicationInsights;
    try {
      // A stale hashed chunk after a redeploy makes this dynamic import reject.
      // Telemetry staying off is an acceptable failure; an unhandled rejection is not.
      const { ApplicationInsights: AppInsights } = await load();
      appInsights = new AppInsights({
        config: {
          connectionString,
          enableCorsCorrelation: true,
          correlationHeaderDomains: hosts,
          enableAutoRouteTracking: false,
          enableUnhandledPromiseRejectionTracking: true,
          // Blocks the SDK's own fetch to js.monitor.azure.com for remote config on a public site.
          extensionConfig: { AppInsightsCfgSyncPlugin: { cfgUrl: '', blkCdnCfg: true } }
        }
      });
      appInsights.loadAppInsights();
      appInsights.addTelemetryInitializer(errorsOnly(role));
    } catch {
      return false;
    }
    this.appInsights = appInsights;

    const held = this.pending;
    this.pending = [];
    for (const item of held) {
      this.trackException(item.error, item.properties);
    }
    return true;
  }

  trackException(error: unknown, properties?: Record<string, string>): void {
    if (!this.appInsights) {
      if (this.pending.length < MAX_PENDING) {
        this.pending.push({ error, properties });
      }
      return;
    }
    this.appInsights.trackException({
      exception: error instanceof Error ? error : new Error(String(error)),
      properties
    });
  }
}
