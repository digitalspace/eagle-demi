import { TestBed } from '@angular/core/testing';
import { AppComponent, SHELL_NARROW_QUERY } from './app.component';
import { provideRouter, Router } from '@angular/router';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { routes } from './app.routes';
import { RegistryStateService } from './services/registry-state.service';
import { NAV_KEY, PREFS_KEY } from './shell/prefs';

// Any payload loadData() accepts. A fresh Response per call: a body can only be read once.
const okResponse = () => new Response(JSON.stringify([{ searchResults: [] }]), {
  status: 200,
  headers: { 'Content-Type': 'application/json' }
});

describe('AppComponent', () => {
  beforeEach(async () => {
    // The sidebar state is read from localStorage at construction, so a spec that collapses it
    // would otherwise decide the layout of the ones that follow.
    localStorage.removeItem(NAV_KEY);
    localStorage.removeItem(PREFS_KEY);

    // AppComponent injects RegistryStateService, whose constructor kicks off I/O:
    // initKeycloak() -> authSettled() -> loadData(). Unstubbed, that issued a real request,
    // karma answered 404, and the rejection settled after this spec had finished — which jasmine 7
    // reports as a run-level ERROR. See registry-state.service.spec.ts for the full note.
    spyOn(window, 'fetch').and.callFake(() => Promise.resolve(okResponse()));

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter(routes),
        provideHttpClient(withXhr()),
        provideHttpClientTesting()
      ]
    }).compileComponents();
  });

  /**
   * Renders the shell for the given auth state and returns its root element. `narrow` answers the
   * shell's own media query, so the viewport karma happens to run at cannot decide the layout.
   */
  const renderAs = async (authenticated: boolean, unauthorized: boolean, narrow = false) => {
    const realMatchMedia = window.matchMedia.bind(window);
    spyOn(window, 'matchMedia').and.callFake((query: string) => query === SHELL_NARROW_QUERY
      ? {
          matches: narrow,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined
        } as unknown as MediaQueryList
      : realMatchMedia(query));

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

  // The two generated-summary screens are named apart: one summarises a search, one a project.
  it('names each AI screen for what it summarises', async () => {
    const { el } = await renderAs(true, false);
    const labelOf = (path: string) =>
      el.querySelector<HTMLAnchorElement>(`.app-sidebar__link[href="${path}"]`)?.textContent?.trim();

    expect(labelOf('/summary')).toBe('AI Search Summary');
    expect(labelOf('/projects')).toBe('AI Project Summary');
  });

  // The sidebar links at the picker, not at one hard-coded project.
  it('points the project screen at the picker', async () => {
    const { el } = await renderAs(true, false);
    const hrefs = Array.from(el.querySelectorAll<HTMLAnchorElement>('.app-sidebar__link'))
      .map(a => a.getAttribute('href'));

    expect(hrefs).toContain('/projects');
    expect(hrefs.some(href => href?.startsWith('/projects/'))).toBe(false);
  });

  // A screen owns every URL under its path, so the deep link the sidebar points at is still the
  // AI Project Summary screen and not an unknown one.
  it('treats a URL under a screen path as that screen', async () => {
    const { fixture } = await renderAs(true, false);

    await TestBed.inject(Router).navigateByUrl('/projects/272');

    expect(fixture.componentInstance.screenKey()).toBe('project');
  });

  it('opens the info panel for the screen the deep link belongs to', async () => {
    const { el, fixture } = await renderAs(true, false);
    await TestBed.inject(Router).navigateByUrl('/projects/272');
    fixture.detectChanges();

    el.querySelector<HTMLButtonElement>('button[aria-label="How this screen is built"]')!.click();
    fixture.detectChanges();

    expect(el.querySelector('[role="dialog"] h2')?.textContent)
      .toContain('How AI Project Summary is built');
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

    await router.navigateByUrl('/workspace');

    expect(service.gatingFilter().size).toBe(0);
    expect(service.sectorFilter().size).toBe(0);
    expect(service.regionFilter().size).toBe(0);
    expect(service.boundaryFilter()).toEqual({});
    expect(service.lassoPolygon()).toBeNull();
    expect(service.lassoLabel()).toBeNull();
  });

  it('clears the search text when navigating between screens', async () => {
    await renderAs(true, false);
    const service = TestBed.inject(RegistryStateService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/workspace');
    service.searchQuery.set('cariboo');

    await router.navigateByUrl('/map');

    expect(service.searchQuery()).toBe('');
  });

  // The corpus in memory was read under the words being left behind, so clearing them is only half
  // the job: the screen arriving has to read it again or it shows rows that match the old search.
  it('re-reads the search on arrival when text was typed', async () => {
    await renderAs(true, false);
    const service = TestBed.inject(RegistryStateService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/workspace');
    service.searchQuery.set('cariboo');
    const loadData = spyOn(service, 'loadData');

    await router.navigateByUrl('/search');

    expect(service.searchQuery()).toBe('');
    expect(loadData).toHaveBeenCalledTimes(1);
  });

  it('does not re-read the search on arrival when there is nothing typed', async () => {
    await renderAs(true, false);
    const service = TestBed.inject(RegistryStateService);
    const loadData = spyOn(service, 'loadData');

    await TestBed.inject(Router).navigateByUrl('/workspace');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(loadData).not.toHaveBeenCalled();
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

  const menuButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.app-header__menu');
  const sidebar = (el: HTMLElement) => el.querySelector<HTMLElement>('.app-sidebar')!;

  it('opens the navigation drawer from the header below the breakpoint', async () => {
    const { el, fixture } = await renderAs(true, false, true);
    const button = menuButton(el)!;
    expect(button.getAttribute('aria-label')).toBe('Main navigation');
    expect(button.getAttribute('aria-controls')).toBe(sidebar(el).id);
    expect(button.getAttribute('aria-expanded')).toBe('false');

    button.click();
    fixture.detectChanges();

    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(sidebar(el).getAttribute('data-drawer')).toBe('open');
    expect(sidebar(el).hasAttribute('inert')).toBe(false);
    expect(getComputedStyle(sidebar(el)).display).not.toBe('none');
  });

  // Translated off-screen is not closed: the links would still take tab focus and still be read out.
  it('takes the closed drawer out of the page below the breakpoint', async () => {
    const { el } = await renderAs(true, false, true);

    expect(sidebar(el).getAttribute('data-drawer')).toBe('closed');
    expect(sidebar(el).hasAttribute('inert')).toBe(true);
    expect(getComputedStyle(sidebar(el)).display).toBe('none');
  });

  it('closes the drawer on Escape and on following a link inside it', async () => {
    const { el, fixture } = await renderAs(true, false, true);
    const open = () => {
      menuButton(el)!.click();
      fixture.detectChanges();
      expect(menuButton(el)!.getAttribute('aria-expanded')).toBe('true');
    };

    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(menuButton(el)!.getAttribute('aria-expanded')).toBe('false');

    open();
    el.querySelector<HTMLAnchorElement>('.app-sidebar__link')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(menuButton(el)!.getAttribute('aria-expanded')).toBe('false');
    expect(sidebar(el).getAttribute('data-drawer')).toBe('closed');
  });

  it('leaves the rail in place above the breakpoint', async () => {
    const { el } = await renderAs(true, false);

    expect(menuButton(el)!.getAttribute('aria-expanded')).toBe('true');
    expect(sidebar(el).hasAttribute('data-drawer')).toBe(false);
    expect(sidebar(el).hasAttribute('inert')).toBe(false);
    expect(getComputedStyle(sidebar(el)).position).toBe('static');
  });

  // A 250px rail leaves a 1280px window too little for the search table, and a collapsed stub
  // would still cost that column its width.
  it('collapses the rail out of the row from the header above the breakpoint', async () => {
    const { el, fixture } = await renderAs(true, false);
    const button = menuButton(el)!;

    button.click();
    fixture.detectChanges();

    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(getComputedStyle(sidebar(el)).display).toBe('none');
    expect(localStorage.getItem(NAV_KEY)).toBe('false');
  });

  // The state describes one browser window, and PUT /me/prefs refuses keys outside its allow-list.
  it('keeps the collapsed rail out of the account prefs', async () => {
    const { el, fixture } = await renderAs(true, false);

    menuButton(el)!.click();
    fixture.detectChanges();

    expect(localStorage.getItem(PREFS_KEY)).toBeNull();
  });

  it('starts collapsed above the breakpoint when this browser collapsed it before', async () => {
    localStorage.setItem(NAV_KEY, 'false');

    const { el } = await renderAs(true, false);

    expect(menuButton(el)!.getAttribute('aria-expanded')).toBe('false');
    expect(getComputedStyle(sidebar(el)).display).toBe('none');
  });

  // Off-canvas the button owns the drawer, so a collapsed desktop rail must not reach it.
  it('opens the drawer below the breakpoint while the desktop rail is collapsed', async () => {
    localStorage.setItem(NAV_KEY, 'false');
    const { el, fixture } = await renderAs(true, false, true);
    expect(sidebar(el).getAttribute('data-drawer')).toBe('closed');

    menuButton(el)!.click();
    fixture.detectChanges();

    expect(sidebar(el).getAttribute('data-drawer')).toBe('open');
    expect(getComputedStyle(sidebar(el)).display).not.toBe('none');
    expect(localStorage.getItem(NAV_KEY)).toBe('false');
  });

  // `.visually-hidden` is position:absolute with no inset. Unpositioned, this scroll container is
  // not its containing block, so a label far down a long screen is laid out against the document
  // and the window scrolls thousands of pixels past the 100vh shell.
  it('makes the scrolling main a containing block for absolute children', async () => {
    const { el } = await renderAs(true, false);
    const main = el.querySelector('.app__main')!;
    expect(getComputedStyle(main).position).toBe('relative');
  });
});
