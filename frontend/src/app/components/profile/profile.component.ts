import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { RegistryStateService } from '../../services/registry-state.service';

interface Prefs { landing: string; perPage: number; }

const LANDING_OPTIONS = [
  { key: 'map', label: 'Map Explorer' },
  { key: 'index', label: 'Index Search' },
  { key: 'content', label: 'Document Content Search' },
  { key: 'summary', label: 'AI Summary' },
  { key: 'intake', label: 'Document Intake' }
];

const PER_PAGE_OPTIONS = [6, 12, 24];
const PREFS_KEY = 'demi.prefs';
const DEFAULTS: Prefs = { landing: 'map', perPage: 6 };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (!saved) return { ...DEFAULTS };
    return {
      landing: LANDING_OPTIONS.some(o => o.key === saved.landing) ? saved.landing : DEFAULTS.landing,
      perPage: PER_PAGE_OPTIONS.includes(saved.perPage) ? saved.perPage : DEFAULTS.perPage
    };
  } catch {
    return { ...DEFAULTS };
  }
}

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [],
  templateUrl: './profile.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class ProfileComponent {
  service = inject(RegistryStateService);

  readonly landingOptions = LANDING_OPTIONS;
  readonly perPageOptions = PER_PAGE_OPTIONS;
  readonly realm = this.service.config.KEYCLOAK_REALM || '—';

  prefs = signal<Prefs>(loadPrefs());

  private token = computed(() => this.service.isAuthenticated() ? this.service.keycloak?.tokenParsed : null);

  name = computed(() => this.token()?.name || '—');
  email = computed(() => this.token()?.email || '—');
  idir = computed(() => this.token()?.idir_username || this.token()?.preferred_username || '—');
  roles = computed<string[]>(() => this.token()?.realm_access?.roles || []);
  groups = computed<string[]>(() => this.token()?.groups || []);

  setLanding(event: Event) {
    this.save({ ...this.prefs(), landing: (event.target as HTMLSelectElement).value });
  }

  setPerPage(event: Event) {
    this.save({ ...this.prefs(), perPage: Number((event.target as HTMLSelectElement).value) });
  }

  reset() {
    this.save({ ...DEFAULTS });
  }

  private save(prefs: Prefs) {
    this.prefs.set(prefs);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Private-browsing quota or a blocked store: the choice still holds for this page view.
    }
  }
}
