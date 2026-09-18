import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { RegistryStateService } from './services/registry-state.service';
import { GROUPS, SCREENS } from './shell/screens';
import { SignInComponent } from './shell/sign-in.component';
import { HowBuiltComponent } from './shell/how-built.component';
import { readNavOpen, writeNavOpen } from './shell/prefs';

/**
 * Below this the navigation rail goes off-canvas: a fixed 250px rail leaves a 390px phone about
 * 140px for the screen itself.
 */
export const SHELL_NARROW_QUERY = '(max-width: 899.98px)';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, SignInComponent, HowBuiltComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { '(document:keydown.escape)': 'closeDrawer()' }
})
export class AppComponent {
  service = inject(RegistryStateService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  readonly sections = GROUPS.map(heading => ({ heading, items: SCREENS.filter(s => s.group === heading) }));

  screenKey = signal(this.keyOf(this.router.url));
  isMap = computed(() => this.screenKey() === 'map');
  /** Desktop only: off-canvas the drawer has its own open state. */
  navOpen = signal(readNavOpen());
  narrow = signal(false);
  drawerOpen = signal(false);
  /** Collapsed and off-canvas-closed come to the same thing for the page: no rail in the row. */
  navHidden = computed(() => this.narrow() ? !this.drawerOpen() : !this.navOpen());
  // Keycloak check-sso is async; rendering the gate before it settles flashes sign-in at staff.
  authSettled = signal(false);
  accountOpen = signal(false);
  infoOpen = signal(false);

  constructor() {
    const query = window.matchMedia(SHELL_NARROW_QUERY);
    this.narrow.set(query.matches);
    const onChange = (event: MediaQueryListEvent) => {
      this.narrow.set(event.matches);
      if (!event.matches) this.drawerOpen.set(false);
    };
    query.addEventListener('change', onChange);
    this.destroyRef.onDestroy(() => query.removeEventListener('change', onChange));

    this.service.authReady.then(() => this.authSettled.set(true));
    this.router.events.pipe(takeUntilDestroyed()).subscribe(event => {
      if (!(event instanceof NavigationEnd)) return;
      const next = this.keyOf(event.urlAfterRedirects);
      // Search state is global to the service, so each screen starts clean. Map arrivals may carry a
      // saved lasso from My account; `?q=` carries the words from an older deep link.
      // The map keeps its filters but renders no type picker, so the one filter it cannot show or
      // undo still goes.
      if (next !== 'map') this.service.clearFilters();
      else this.service.clearDocType();
      const q = new URL(event.urlAfterRedirects, location.origin).searchParams.get('q') ?? '';
      const queryChanged = q !== this.service.searchQuery();
      // The corpus in memory was narrowed by the type just dropped, so its rows, counts and
      // dropped callout belong to a filter the picker no longer shows. Re-read them even
      // when the words are unchanged. The query is applied first, so this load never carries the
      // one being left behind.
      const wasTypeFiltered = this.service.hasLoadedDocType();
      if (queryChanged) this.service.searchQuery.set(q);
      if (queryChanged || wasTypeFiltered) this.service.loadData();
      this.screenKey.set(next);
      this.accountOpen.set(false);
    });
  }

  mainStyle = computed(() => this.isMap()
    ? 'padding: 0; display: flex; flex-direction: column; min-height: 0;'
    : 'padding: var(--layout-padding-large);');

  initials = computed(() => {
    const parts = this.service.userName().split(/[\s._@-]+/).filter(Boolean);
    const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0]?.slice(0, 2) || 'BC';
    return letters.toUpperCase();
  });

  closeDrawer() {
    this.drawerOpen.set(false);
  }

  toggleNav() {
    if (this.narrow()) {
      this.drawerOpen.set(!this.drawerOpen());
      return;
    }
    const open = !this.navOpen();
    this.navOpen.set(open);
    writeNavOpen(open);
  }

  logout() {
    this.accountOpen.set(false);
    this.service.logout();
  }

  private keyOf(url: string): string {
    const seg = url.split(/[?#]/)[0].replace(/^\//, '').split('/')[0] || 'map';
    // Compared on the first segment, not the whole path: a screen may carry a deeper one
    // (`/projects/272`), and it still owns every URL under it.
    return SCREENS.find(sc => sc.path.split('/')[1] === seg)?.key ?? seg;
  }
}
