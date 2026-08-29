import { Component, inject, computed, ChangeDetectionStrategy } from '@angular/core';
import { RegistryStateService } from '../../services/registry-state.service';

@Component({
  selector: 'app-sessions',
  standalone: true,
  imports: [],
  templateUrl: './sessions.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class SessionsComponent {
  service = inject(RegistryStateService);

  readonly userAgent = navigator.userAgent;

  private token = computed(() => this.service.isAuthenticated() ? this.service.keycloak?.tokenParsed : null);

  sessionId = computed<string>(() => this.service.keycloak?.sessionId || this.token()?.sid || '');
  issued = computed(() => this.epoch(this.token()?.iat));
  expires = computed(() => this.epoch(this.token()?.exp));

  logout() {
    this.service.logout();
  }

  private epoch(seconds?: number): string {
    return seconds ? new Date(seconds * 1000).toLocaleString('en-CA') : '—';
  }
}
