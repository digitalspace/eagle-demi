import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { RegistryStateService } from './services/registry-state.service';
import { GROUPS, SCREENS } from './shell/screens';
import { SignInComponent } from './shell/sign-in.component';
import { HowBuiltComponent } from './shell/how-built.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, SignInComponent, HowBuiltComponent],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class AppComponent {
  service = inject(RegistryStateService);
  private router = inject(Router);

  readonly sections = GROUPS.map(heading => ({ heading, items: SCREENS.filter(s => s.group === heading) }));

  screenKey = signal(this.keyOf(this.router.url));
  isMap = computed(() => this.screenKey() === 'map');
  navOpen = signal(true);
  // Keycloak check-sso is async; rendering the gate before it settles flashes sign-in at staff.
  authSettled = signal(false);
  accountOpen = signal(false);
  infoOpen = signal(false);

  constructor() {
    this.service.authReady.then(() => this.authSettled.set(true));
    this.router.events.pipe(takeUntilDestroyed()).subscribe(event => {
      if (!(event instanceof NavigationEnd)) return;
      const next = this.keyOf(event.urlAfterRedirects);
      // Map filters are only shown on the map; arriving there may carry a saved lasso from My account.
      if (next !== 'map') this.service.clearFilters();
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

  logout() {
    this.accountOpen.set(false);
    this.service.logout();
  }

  private keyOf(url: string): string {
    const seg = url.split(/[?#]/)[0].replace(/^\//, '').split('/')[0] || 'map';
    return SCREENS.find(sc => sc.path === '/' + seg)?.key ?? seg;
  }
}
