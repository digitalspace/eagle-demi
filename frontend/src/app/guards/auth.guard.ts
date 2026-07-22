import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { RegistryStateService } from '../services/registry-state.service';

export const authGuard: CanActivateFn = (_route, _state) => {
  const service = inject(RegistryStateService);
  const router = inject(Router);

  if (!service.authEnabled()) {
    return true;
  }

  if (service.isAuthenticated() && !service.isUnauthorized()) {
    return true;
  }

  // Redirect to Map Explorer if unauthorized or not logged in
  router.navigate(['/map']);
  return false;
};
