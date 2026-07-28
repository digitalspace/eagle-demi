import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { ConfigService } from '../services/config.service';

/**
 * Functional HTTP Interceptor for attaching Keycloak Bearer token when available
 * without global fetch window object mutation.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const configService = inject(ConfigService);
  const config = configService.config;
  const basePath = config.API_PATH || '/api';

  // Check if request is targeting backend API
  if (req.url.includes(basePath) || req.url.startsWith('/api')) {
    const keycloak = (window as any).Keycloak;
    if (keycloak && keycloak.token) {
      const authReq = req.clone({
        setHeaders: {
          Authorization: `Bearer ${keycloak.token}`
        }
      });
      return next(authReq);
    }
  }

  return next(req);
};
