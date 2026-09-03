import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { provideRouter, Router } from '@angular/router';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { routes } from './app.routes';
import { RegistryStateService } from './services/registry-state.service';

describe('AppComponent', () => {
  beforeEach(async () => {
    // AppComponent injects RegistryStateService, whose constructor kicks off I/O:
    // initKeycloak() -> authSettled() -> loadData(). Unstubbed, that issued a real request,
    // karma answered 404, and the rejection settled after this spec had finished — which jasmine 7
    // reports as a run-level ERROR. See registry-state.service.spec.ts for the full note.
    spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(new Response(JSON.stringify([{ searchResults: [] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    );

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter(routes),
        provideHttpClient(withXhr()),
        provideHttpClientTesting()
      ]
    }).compileComponents();
  });

  /** Renders the shell for the given auth state and returns its root element. */
  const renderAs = async (authenticated: boolean, unauthorized: boolean) => {
    const service = TestBed.inject(RegistryStateService);
    const fixture = TestBed.createComponent(AppComponent);
    // The gate renders nothing until Keycloak settles (authReady); settling also resets the
    // auth signals, so set the scenario after it.
    await service.authReady;
    service.isAuthenticated.set(authenticated);
    service.isUnauthorized.set(unauthorized);
    fixture.detectChanges();
    return { el: fixture.nativeElement as HTMLElement, fixture };
  };

  it('should create the app', () => {
    expect(TestBed.createComponent(AppComponent).componentInstance).toBeTruthy();
  });

  it('shows the sign-in screen and no navigation to an anonymous visitor', async () => {
    const { el } = await renderAs(false, false);
    expect(el.querySelector('app-sign-in')).toBeTruthy();
    expect(el.querySelector('.app-sidebar')).toBeNull();
  });

  // A real account carrying none of sysadmin / staff / demi-admin. Say so — a second login
  // cannot fix it — rather than bouncing the visitor back to a blank sign-in screen.
  it('explains the rejection when the account has no staff role', async () => {
    const { el } = await renderAs(true, true);
    expect(el.textContent).toContain('no EPIC staff role');
    expect(el.querySelector('.app-sidebar')).toBeNull();
  });

  it('shows the four sidebar groups and every screen link to staff', async () => {
    const { el } = await renderAs(true, false);
    expect(el.querySelector('app-sign-in')).toBeNull();

    const headings = Array.from(el.querySelectorAll('.app-sidebar__heading')).map(h => h.textContent?.trim());
    expect(headings).toEqual(['Discover', 'Account', 'Operate', 'Reference']);

    // Every screen is in the sidebar; My account and sessions also keep their account-menu shortcuts.
    expect(el.querySelectorAll('.app-sidebar__link').length).toBe(11);
  });

  it('sends an old /profile link to My account', async () => {
    await renderAs(true, false);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/profile');
    expect(router.url).toBe('/workspace');
  });

  const RING = [[-121, 56], [-120, 56], [-120.5, 56.5]];

  const setAllFilters = (service: RegistryStateService) => {
    service.gatingFilter.set(new Set(['staged']));
    service.sectorFilter.set(new Set(['Mineral Mines']));
    service.regionFilter.set(new Set(['Cariboo']));
    service.boundaryFilter.set({ regionalDistrict: new Set(['Cariboo']) });
    service.lassoPolygon.set(RING);
    service.lassoLabel.set('Peace Valley');
  };

  it('clears every map filter when navigating off the map', async () => {
    await renderAs(true, false);
    const service = TestBed.inject(RegistryStateService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/map');
    setAllFilters(service);

    await router.navigateByUrl('/index');

    expect(service.gatingFilter().size).toBe(0);
    expect(service.sectorFilter().size).toBe(0);
    expect(service.regionFilter().size).toBe(0);
    expect(service.boundaryFilter()).toEqual({});
    expect(service.lassoPolygon()).toBeNull();
    expect(service.lassoLabel()).toBeNull();
  });

  it('keeps a lasso set before arriving on the map', async () => {
    await renderAs(true, false);
    const service = TestBed.inject(RegistryStateService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/workspace');
    service.lassoPolygon.set(RING);

    await router.navigateByUrl('/map');

    expect(service.lassoPolygon()).toEqual(RING);
  });

  it('keeps the sidebar open when navigating to the map', async () => {
    const { el, fixture } = await renderAs(true, false);
    await TestBed.inject(Router).navigateByUrl('/map');
    fixture.detectChanges();
    expect(el.querySelectorAll('.app-sidebar__link').length).toBe(11);
  });
});
