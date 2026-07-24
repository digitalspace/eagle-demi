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
    this.configuration = (window as any)['__env'] || {};

    if (this.configuration.configEndpoint === true) {
      try {
        const liveConfig = await firstValueFrom(this.http.get<AppConfig>('/api/config'));
        this.configuration = { ...this.configuration, ...liveConfig };
        console.log('[ConfigService] Dynamic configuration loaded from /api/config:', this.configuration);
      } catch (e) {
        console.warn('[ConfigService] Failed to load runtime config from /api/config, fallback to window.__env:', e);
      }
    }
  }

  get config(): AppConfig {
    return this.configuration;
  }

  get(key: string, defaultValue?: any): any {
    return this.configuration[key] !== undefined ? this.configuration[key] : defaultValue;
  }
}
