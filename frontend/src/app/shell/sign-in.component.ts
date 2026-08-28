import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RegistryStateService } from '../services/registry-state.service';

@Component({
  selector: 'app-sign-in',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div style="min-height: 100vh; display: flex; flex-direction: column; background: var(--surface-color-primary-default);">
      <div style="height: 4px; background: var(--theme-primary-gold);"></div>
      <div style="flex: 1; display: grid; place-items: center; padding: var(--layout-padding-large);">
        <div style="text-align: center; display: flex; flex-direction: column; align-items: center; gap: var(--layout-margin-medium); max-width: 30rem;">
          <img src="assets/bcgov-header-vert.png" alt="Government of British Columbia" style="height: 76px; width: auto;">
          <h1 style="font: var(--typography-bold-h2); color: var(--surface-color-background-white); margin: 0;">DEMI</h1>
          <p style="font: var(--typography-regular-body); color: var(--eao-on-dark-muted); margin: 0;">Digital File Library &amp; Document Registry</p>
          <button type="button" (click)="service.loginKeycloak()" style="margin-top: var(--layout-margin-small); background: var(--theme-primary-gold); color: var(--surface-color-primary-default); border: none; border-radius: var(--layout-border-radius-small); padding: 0.8rem 1.6rem; font: var(--typography-bold-body); cursor: pointer;">Sign in</button>
          @if (rejected()) {
            <p style="font: var(--typography-regular-small-body); color: var(--theme-primary-gold); margin: 0; max-width: 24rem;">That account signed in successfully but carries no EPIC staff role, so DEMI signed it back out. Ask an administrator for the <code>staff</code> role.</p>
            <button type="button" (click)="service.logout()" style="background: none; border: var(--layout-border-width-small) solid var(--theme-primary-gold); color: var(--theme-primary-gold); border-radius: var(--layout-border-radius-small); padding: 0.4rem 1rem; font: var(--typography-bold-small-body); cursor: pointer;">Sign out</button>
          }
        </div>
      </div>
      <div style="padding: var(--layout-padding-small) var(--layout-padding-large); border-top: 2px solid var(--theme-primary-gold); display: flex; justify-content: space-between; font: var(--typography-regular-label); color: var(--eao-on-dark-muted);">
        <span>Keycloak realm {{ service.config.KEYCLOAK_REALM || 'eao-epic' }}</span>
        <span>{{ service.config.ENVIRONMENT }}</span>
      </div>
    </div>
  `
})
export class SignInComponent {
  service = inject(RegistryStateService);

  // Signed in but role-less: Keycloak accepted the account, DEMI did not.
  rejected = computed(() => this.service.isAuthenticated() && this.service.isUnauthorized());
}
