import { Component, OnInit, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { RegistryStateService } from '../../services/registry-state.service';
import { UserdataService, SavedLasso } from '../../services/userdata.service';
import { Prefs, LANDING_OPTIONS, PER_PAGE_OPTIONS, DEFAULT_PREFS, readPrefs, writePrefs } from '../../shell/prefs';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [],
  templateUrl: './profile.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class ProfileComponent implements OnInit {
  service = inject(RegistryStateService);
  userdata = inject(UserdataService);

  readonly landingOptions = LANDING_OPTIONS;
  readonly perPageOptions = PER_PAGE_OPTIONS;
  readonly realm = this.service.config.KEYCLOAK_REALM || '—';

  prefs = signal<Prefs>(readPrefs());

  private token = computed(() => this.service.isAuthenticated() ? this.service.keycloak?.tokenParsed : null);

  name = computed(() => this.token()?.name || '—');
  email = computed(() => this.token()?.email || '—');
  idir = computed(() => this.token()?.idir_username || this.token()?.preferred_username || '—');
  roles = computed<string[]>(() => this.token()?.realm_access?.roles || []);
  groups = computed<string[]>(() => this.token()?.groups || []);

  ngOnInit() {
    if (this.service.isAuthenticated()) this.userdata.loadMyData();
  }

  deleteLasso(area: SavedLasso) {
    return this.userdata.deleteLasso(area.slug);
  }

  setLanding(event: Event) {
    this.save({ ...this.prefs(), landing: (event.target as HTMLSelectElement).value });
  }

  setPerPage(event: Event) {
    this.save({ ...this.prefs(), perPage: Number((event.target as HTMLSelectElement).value) });
  }

  reset() {
    this.save({ ...DEFAULT_PREFS });
  }

  private save(prefs: Prefs) {
    this.prefs.set(prefs);
    writePrefs(prefs);
    // Fire and forget: the choice already holds in this browser, and the server copy is only
    // what carries it to the next device.
    if (this.service.isAuthenticated()) this.userdata.putPrefs(prefs);
  }
}
