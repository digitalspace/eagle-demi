import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { RegistryStateService } from '../services/registry-state.service';

export const authGuard: CanActivateFn = async (_route, _state) => {
  const service = inject(RegistryStateService);
  const router = inject(Router);

  // Keycloak resolves asynchronously; deciding before it settles would reject valid staff.
  // `isStaff` short-circuits to true when auth is disabled, so this await is harmless there —
  // `authSettled()` resolves immediately on that path.
  await service.authReady;

  // The SAME predicate the nav and the filters use. These were two different questions before —
  // nav visibility on a role toggle, route activation on the Keycloak signals — so a staff member
  // in "public view" lost the nav tab but could still reach the route by typing the URL.
  if (service.isStaff()) {
    return true;
  }

  // Redirect to Map Explorer if unauthorized or not logged in
  return router.parseUrl('/map');
};
