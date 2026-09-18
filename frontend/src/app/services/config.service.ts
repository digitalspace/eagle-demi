import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

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
  [key: string]: any;
}

/**
 * Provides a centralized place to persist and dynamically fetch configuration values.
 * Get configuration data from front-end window.__env or from /api/config if configEndpoint is true.
 */
@Injectable({
  providedIn: 'root'
})
export class ConfigService {
  private http = inject(HttpClient);

  private configuration: AppConfig = {};

  async init(): Promise<void> {
    this.configuration = (window as unknown as { __env?: AppConfig }).__env || {};
    const apiBase = this.apiBase();

    // The public document is the feature-flag mirror the public site boots on (CONTENT_SEARCH and
    // friends). It is unauthenticated and carries no API location, so it is read whichever way this
    // app is configured, and it sits under window.__env: a key this app sets for itself still wins.
    const [publicConfig, liveConfig] = await Promise.all([
      this.load(`${apiBase}/config/public`),
      this.configuration.configEndpoint === true ? this.load(`${apiBase}/config`) : Promise.resolve(null)
    ]);

    this.configuration = { ...publicConfig, ...this.configuration, ...liveConfig };
  }

  /** Where both config documents live, given whatever base the page was booted with. */
  private apiBase(): string {
    if (this.configuration.API_PATH) {
      return this.configuration.API_PATH.replace(/\/$/, '');
    }
    if (this.configuration.API_LOCATION) {
      return `${this.configuration.API_LOCATION.replace(/\/$/, '')}/api`;
    }
    return '/api';
  }

  private async load(url: string): Promise<AppConfig | null> {
    try {
      return await firstValueFrom(this.http.get<AppConfig>(url));
    } catch (e) {
      console.warn(`[ConfigService] ${url} did not answer, falling back to window.__env:`, e);
      return null;
    }
  }

  get config(): AppConfig {
    return this.configuration;
  }

  get(key: string, defaultValue?: any): any {
    return this.configuration[key] !== undefined ? this.configuration[key] : defaultValue;
  }
}
