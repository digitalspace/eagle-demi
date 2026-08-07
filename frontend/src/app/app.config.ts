import { ApplicationConfig, provideAppInitializer, provideZoneChangeDetection, inject } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { routes } from './app.routes';
import { ConfigService } from './services/config.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    // Bearer tokens are attached by the window.fetch interceptor in RegistryStateService;
    // HttpClient is only used by ConfigService, which runs before Keycloak initialises.
    provideHttpClient(withXhr()),
    provideAppInitializer(() => inject(ConfigService).init())
  ]
};


