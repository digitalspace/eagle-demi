import { ApplicationConfig, ErrorHandler, provideAppInitializer, provideZoneChangeDetection, inject } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { routes } from './app.routes';
import { ConfigService } from './services/config.service';
import { TelemetryErrorHandler } from './services/telemetry-error-handler';
import { TelemetryService, correlationHosts } from './services/telemetry.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    // Bearer tokens are attached by the window.fetch interceptor in RegistryStateService;
    // HttpClient is only used by ConfigService, which runs before Keycloak initialises.
    provideHttpClient(withXhr()),
    { provide: ErrorHandler, useClass: TelemetryErrorHandler },
    provideAppInitializer(() => {
      const config = inject(ConfigService);
      const telemetry = inject(TelemetryService);
      return config.init().then(() => {
        // Not awaited: the App Insights chunk must not hold the first render.
        void telemetry.init(
          config.get('APPINSIGHTS_CONNECTION_STRING'),
          'eagle-demi-frontend',
          correlationHosts(config.get('API_PATH'))
        );
      });
    })
  ]
};
