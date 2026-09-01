import { ComponentFixture, TestBed } from '@angular/core/testing';
import type * as Leaflet from 'leaflet';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { MyWorkspaceComponent } from './my-workspace.component';
import { RegistryStateService } from '../../services/registry-state.service';
import { UserdataService, SavedLasso } from '../../services/userdata.service';
import { LinksService, ShortLink } from '../../services/links.service';
import { PREFS_KEY } from '../../shell/prefs';

const PEACE_VALLEY: number[][] = [[-121, 56], [-120, 56], [-120.5, 56.5]];
const SKEENA: number[][] = [[-128, 54], [-127, 54], [-127.5, 54.8]];

const lasso = (slug: string, name: string, ring: number[][]): SavedLasso =>
  ({ slug, name, ring, updatedAt: '2026-08-30T00:00:00.000Z' });

const link = (id: string, createdBy: string, personal = false): ShortLink => ({
  id,
  url: `https://demi.gov.bc.ca/projects/${id}`,
  note: null,
  shortUrl: `https://demi.gov.bc.ca/s/${id}`,
  createdAt: '2026-08-24T00:00:00.000Z',
  createdBy,
  updatedAt: null,
  personal
});

describe('MyWorkspaceComponent', () => {
  let fixture: ComponentFixture<MyWorkspaceComponent>;
  let registry: RegistryStateService;
  let userdata: UserdataService;
  let links: LinksService;
  let router: Router;

  beforeEach(async () => {
    localStorage.clear();
    // RegistryStateService's constructor kicks off I/O — see registry-state.service.spec.ts.
    spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    );

    await TestBed.configureTestingModule({
      imports: [MyWorkspaceComponent],
      providers: [provideRouter([]), provideHttpClient(withXhr()), provideHttpClientTesting()]
    }).compileComponents();

    registry = TestBed.inject(RegistryStateService);
    await registry.authReady;
    userdata = TestBed.inject(UserdataService);
    links = TestBed.inject(LinksService);
    spyOn(userdata, 'loadMyData').and.resolveTo();
    spyOn(links, 'load').and.resolveTo();
    router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
    fixture = TestBed.createComponent(MyWorkspaceComponent);
  });

  /** Signs in as J.Okafor and renders, so ngOnInit's loads are already stubbed out. */
  function signedIn(): HTMLElement {
    (registry as unknown as { keycloak: unknown }).keycloak = { tokenParsed: { preferred_username: 'J.Okafor' } };
    registry.isAuthenticated.set(true);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /** The mini-map's polygon, in the [lng,lat] order the saved ring uses. */
  function overlayRing(): number[][] {
    const layer = (fixture.componentInstance as unknown as { ringLayer: Leaflet.Polygon }).ringLayer;
    return (layer.getLatLngs()[0] as Leaflet.LatLng[]).map(p => [p.lng, p.lat]);
  }

  it('lists every saved area and overlays the first one on the map', () => {
    const el = signedIn();
    userdata.lassos.set([lasso('peace-valley', 'Peace Valley', PEACE_VALLEY), lasso('skeena', 'Skeena', SKEENA)]);
    fixture.detectChanges();

    expect(el.textContent).toContain('Peace Valley');
    expect(el.textContent).toContain('Skeena');
    expect(el.querySelectorAll('.leaflet-container').length).toBe(1);
    expect(fixture.componentInstance.selected()?.slug).toBe('peace-valley');
    expect(overlayRing()).toEqual(PEACE_VALLEY);
  });

  it('swaps the overlay to the area picked from the list', () => {
    const el = signedIn();
    userdata.lassos.set([lasso('peace-valley', 'Peace Valley', PEACE_VALLEY), lasso('skeena', 'Skeena', SKEENA)]);
    fixture.detectChanges();

    Array.from(el.querySelectorAll('button')).find(b => b.textContent?.includes('Skeena'))!.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.selected()?.slug).toBe('skeena');
    expect(overlayRing()).toEqual(SKEENA);
  });

  it('marks only the selected row, for the tint and the bar beside it', () => {
    const el = signedIn();
    userdata.lassos.set([lasso('peace-valley', 'Peace Valley', PEACE_VALLEY), lasso('skeena', 'Skeena', SKEENA)]);
    fixture.detectChanges();

    const rows = Array.from(el.querySelectorAll('li'));
    const marked = rows.filter(li => li.classList.contains('kv-row--selected'));
    expect(marked.length).toBe(1);
    expect(marked[0].textContent).toContain('Peace Valley');
    expect(marked[0].querySelector('button')!.getAttribute('aria-current')).toBe('true');
    expect(rows.find(li => li.textContent?.includes('Skeena'))!.querySelector('button')!.getAttribute('aria-current')).toBeNull();
  });

  it('hands the selection to the next area when the selected one is deleted', () => {
    const el = signedIn();
    const areas = [lasso('a', 'Alpha', PEACE_VALLEY), lasso('b', 'Bravo', SKEENA), lasso('c', 'Charlie', PEACE_VALLEY)];
    userdata.lassos.set(areas);
    fixture.detectChanges();

    fixture.componentInstance.select(areas[1]);
    spyOn(userdata, 'deleteLasso').and.resolveTo(true);
    const row = Array.from(el.querySelectorAll('li')).find(li => li.textContent?.includes('Bravo'))!;
    Array.from(row.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Delete')!.click();
    // The API reload the delete triggers is stubbed out, so stand in for it.
    userdata.lassos.set([areas[0], areas[2]]);
    fixture.detectChanges();

    expect(fixture.componentInstance.selected()?.slug).toBe('c');
  });

  it('puts the ring on the map before navigating there', () => {
    const el = signedIn();
    userdata.lassos.set([lasso('peace-valley', 'Peace Valley', PEACE_VALLEY)]);
    fixture.detectChanges();

    const apply = Array.from(el.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Apply on map');
    apply!.click();

    expect(registry.lassoPolygon()).toEqual(PEACE_VALLEY);
    expect(registry.lassoLabel()).toBe('Peace Valley');
    expect(router.navigate).toHaveBeenCalledWith(['/map']);
  });

  it('deletes a saved area by its slug', () => {
    const el = signedIn();
    userdata.lassos.set([lasso('peace-valley', 'Peace Valley', PEACE_VALLEY)]);
    fixture.detectChanges();

    const remove = spyOn(userdata, 'deleteLasso').and.resolveTo(true);
    const button = Array.from(el.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Delete');
    button!.click();

    expect(remove).toHaveBeenCalledWith('peace-valley');
  });

  // The API lowercases createdBy; the token claim is not guaranteed to be, so a case-sensitive
  // comparison would leave this list empty for everyone.
  it('lists my links only, badging the personal one', () => {
    const el = signedIn();
    links.links.set([link('mine-a', 'j.okafor', true), link('theirs-a', 'r.singh')]);
    fixture.detectChanges();

    expect(fixture.componentInstance.myLinks().map(l => l.id)).toEqual(['mine-a']);
    expect(el.textContent).toContain('mine-a');
    expect(el.textContent).not.toContain('theirs-a');
    expect(el.querySelectorAll('.pill--info').length).toBe(1);
  });

  it('renders real roles as chips in one wrapping row, dropping the Keycloak boilerplate', () => {
    (registry as unknown as { keycloak: unknown }).keycloak = {
      tokenParsed: {
        name: 'Jane Okafor',
        preferred_username: 'J.Okafor',
        realm_access: { roles: ['default-roles-eao-epic', 'demi-admin', 'offline_access', 'staff', 'uma_authorization'] }
      }
    };
    registry.isAuthenticated.set(true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const chips = Array.from(el.querySelectorAll('.role-chips .role-chip'));
    expect(chips.map(c => c.textContent?.trim())).toEqual(['demi-admin', 'staff']);
    expect(el.textContent).not.toContain('default-roles-eao-epic');
    expect(fixture.componentInstance.initials()).toBe('JO');
  });

  it('says so when the account carries no role beyond the defaults', () => {
    (registry as unknown as { keycloak: unknown }).keycloak = {
      tokenParsed: { name: 'Jane Okafor', realm_access: { roles: ['offline_access'] } }
    };
    registry.isAuthenticated.set(true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.role-chip')).toBeNull();
    expect(el.textContent).toContain('None beyond the Keycloak defaults.');
  });

  it('invites a first lasso when there are none', () => {
    const el = signedIn();
    expect(el.textContent).toContain('Draw a lasso');
    expect(el.querySelector('.leaflet-container')).toBeNull();
  });

  it('shows the email and groups the token carries', () => {
    (registry as unknown as { keycloak: unknown }).keycloak = {
      tokenParsed: { name: 'Jane Okafor', email: 'jane.okafor@gov.bc.ca', groups: ['EAO Staff', 'DEMI Pilot'] }
    };
    registry.isAuthenticated.set(true);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('jane.okafor@gov.bc.ca');
    expect(el.textContent).toContain('EAO Staff, DEMI Pilot');
  });

  it('writes a preference change to BOTH localStorage and the API', () => {
    const putPrefs = spyOn(userdata, 'putPrefs').and.resolveTo(true);
    signedIn();

    fixture.componentInstance.setLanding({ target: { value: 'index' } } as unknown as Event);

    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ landing: 'index', perPage: 6 });
    expect(putPrefs).toHaveBeenCalledWith({ landing: 'index', perPage: 6 });
  });

  it('does not call the API for an anonymous visitor', () => {
    const putPrefs = spyOn(userdata, 'putPrefs').and.resolveTo(true);
    registry.isAuthenticated.set(false);
    fixture.detectChanges();

    fixture.componentInstance.setPerPage({ target: { value: '24' } } as unknown as Event);

    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).perPage).toBe(24);
    expect(putPrefs).not.toHaveBeenCalled();
  });

  it('puts every preference back to its default on reset', () => {
    const putPrefs = spyOn(userdata, 'putPrefs').and.resolveTo(true);
    signedIn();
    fixture.componentInstance.setLanding({ target: { value: 'index' } } as unknown as Event);

    const el = fixture.nativeElement as HTMLElement;
    Array.from(el.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Reset to defaults')!.click();

    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ landing: 'map', perPage: 6 });
    expect(putPrefs).toHaveBeenCalledWith({ landing: 'map', perPage: 6 });
  });

  it('starts the editor from the account copy once /me/data has answered', () => {
    signedIn();
    userdata.prefs.set({ landing: 'content', perPage: 24 });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect((el.querySelector('#pref-landing') as HTMLSelectElement).value).toBe('content');
    expect((el.querySelector('#pref-per-page') as HTMLSelectElement).value).toBe('24');
  });
});
