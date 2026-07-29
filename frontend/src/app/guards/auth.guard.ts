import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { RegistryStateService } from '../services/registry-state.service';

export const authGuard: CanActivateFn = async (_route, _state) => {
  const service = inject(RegistryStateService);
  const router = inject(Router);

  if (!service.authEnabled()) {
    return true;
  }

  // Keycloak resolves asynchronously; deciding before it settles would reject valid admins
  await service.authReady;

  if (service.isAuthenticated() && !service.isUnauthorized()) {
    return true;
  }

  // Redirect to Map Explorer if unauthorized or not logged in
  return router.parseUrl('/map');
};
