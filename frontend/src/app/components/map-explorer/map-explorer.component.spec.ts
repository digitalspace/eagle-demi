import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { MapExplorerComponent } from './map-explorer.component';
import { RegistryStateService } from '../../services/registry-state.service';
import { UserdataService, SavedLasso } from '../../services/userdata.service';
import { Project } from '../../models/registry.models';

const PEACE_VALLEY: SavedLasso = {
  slug: 'peace-valley',
  name: 'Peace Valley',
  ring: [[-121, 56], [-120, 56], [-120.5, 56.5]],
  updatedAt: '2026-08-30T00:00:00.000Z'
};

type Wildfire = NonNullable<NonNullable<Project['sources']>['wildfire']>;

const project = (wildfire?: Wildfire, extra: Partial<Project> = {}): Project => ({
  id: 1,
  name: 'Test Project',
  sector: 'Mines',
  status: 'Active',
  legacyEagleId: 'abc',
  centroid: [-123, 49],
  gatingState: 'admitted',
  region: 'Kootenay',
  description: '',
  proponent: 'Someone',
  ...(wildfire ? { sources: { wildfire } } : {}),
  ...extra
});

describe('MapExplorerComponent wildfire panel', () => {
  let fixture: ComponentFixture<MapExplorerComponent>;
  let service: RegistryStateService;

  beforeEach(async () => {
    // RegistryStateService's constructor kicks off I/O — see registry-state.service.spec.ts.
    spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(new Response(JSON.stringify([{ searchResults: [] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    );

    await TestBed.configureTestingModule({
      imports: [MapExplorerComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), provideRouter([])]
    }).compileComponents();

    fixture = TestBed.createComponent(MapExplorerComponent);
    // ngAfterViewInit builds a real Leaflet map; the test fixture has no sized map element.
    spyOn(fixture.componentInstance as any, 'initMap');
    service = TestBed.inject(RegistryStateService);
  });

  it('renders counts and the fires-of-note warning', () => {
    service.selectedProject.set(project({
      activeCountWithin50km: 3,
      nearestDistanceKm: 43,
      firesOfNoteNearby: 1,
      lastCalculatedAt: '2026-08-11T05:18:15.746Z'
    }));
    // Wildfire proximity lives in the detail card's field rows, which only render expanded.
    fixture.componentInstance.detailsExpanded.set(true);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('3 active fires');
    expect(text).toContain('Fires of Note Nearby');
    expect(text).toContain('43 km');
    expect(text).toContain('as of');
  });

  it('hides the wildfire rows when sources.wildfire is absent', () => {
    service.selectedProject.set(project());
    fixture.componentInstance.detailsExpanded.set(true);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Test Project');
    expect(text).not.toContain('Nearby fires');
  });

  it('hands the project name to Index Search through ?q=', () => {
    const router = TestBed.inject(Router);
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);

    fixture.componentInstance.viewProjectDocuments(project());

    expect(navigate).toHaveBeenCalledWith(['/index'], { queryParams: { q: 'Test Project' } });
    expect(service.searchQuery()).toBe('');
  });
});

describe('MapExplorerComponent EAC number', () => {
  let fixture: ComponentFixture<MapExplorerComponent>;
  let service: RegistryStateService;

  beforeEach(async () => {
    spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(new Response(JSON.stringify([{ searchResults: [] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    );

    await TestBed.configureTestingModule({
      imports: [MapExplorerComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), provideRouter([])]
    }).compileComponents();

    fixture = TestBed.createComponent(MapExplorerComponent);
    spyOn(fixture.componentInstance as any, 'initMap');
    service = TestBed.inject(RegistryStateService);
  });

  it('shows the certificate in the collapsed card', () => {
    service.selectedProject.set(project(undefined, { eaCertificate: 'E05-01' }));
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('EA Certificate');
    expect(text).toContain('E05-01');
  });

  it('renders a state word verbatim, like any other value', () => {
    // Track uses the column for certificate STATE as well as numbers — 58 records read "Withdrawn".
    // Anything that showed only pattern-matching values would blank ~100 projects.
    service.selectedProject.set(project(undefined, { eaCertificate: 'Withdrawn' }));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent ?? '').toContain('Withdrawn');
  });

  it('shows it in the expanded field rows too, tagged TRACK', () => {
    service.selectedProject.set(project(undefined, { eaCertificate: 'E05-01' }));
    fixture.componentInstance.detailsExpanded.set(true);
    fixture.detectChanges();

    const row = fixture.componentInstance.fieldRows().find(r => r.key === 'EA Certificate');
    expect(row).toBeDefined();
    expect(row!.value).toBe('E05-01');
    expect(row!.source).toBe('TRACK');
  });

  it('renders no row at all when the project has no certificate', () => {
    // Most projects never got one; an empty placeholder row would read as a missing value.
    service.selectedProject.set(project());
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Test Project');
    expect(text).not.toContain('EA Certificate');
  });
});

describe('MapExplorerComponent marker selection', () => {
  let fixture: ComponentFixture<MapExplorerComponent>;
  let component: MapExplorerComponent;
  let service: RegistryStateService;
  let cluster: jasmine.SpyObj<{ addLayer: (m: any) => void; removeLayer: (m: any) => void }>;
  let map: any;
  let markerA: any;
  let markerB: any;

  // `eaCertificate: null` keeps `selectProject` from firing its hydration read, which would
  // re-enter the selection effect halfway through a test.
  const projectA = project(undefined, { id: 1, name: 'Alpha', eaCertificate: null });
  const projectB = project(undefined, { id: 2, name: 'Bravo', centroid: [-124, 50], eaCertificate: null });
  /** A project the map has no marker for — no centroid, or filtered out of the cluster group. */
  const homeless = project(undefined, { id: 99, name: 'Nowhere', centroid: undefined, eaCertificate: null });

  const host = () => document.getElementById('demi-map')!;
  const row = (id: number) => document.getElementById(`demi-row-${id}`)!;
  /** The stand-in the component added to the selection pane, if it added one. */
  const popped = () => map.addLayer.calls.mostRecent()?.args[0];
  const iconClass = (marker: any) => String(marker.options.icon.options.className);

  beforeEach(async () => {
    spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(new Response(JSON.stringify([{ searchResults: [] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    );

    await TestBed.configureTestingModule({
      imports: [MapExplorerComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), provideRouter([])]
    }).compileComponents();

    fixture = TestBed.createComponent(MapExplorerComponent);
    component = fixture.componentInstance;
    spyOn(component as any, 'initMap');
    service = TestBed.inject(RegistryStateService);

    map = jasmine.createSpyObj('map',
      ['addLayer', 'removeLayer', 'flyTo', 'panTo', 'getZoom', 'getBounds', 'getContainer', 'on', 'remove']);
    map.getZoom.and.returnValue(9);
    map.getBounds.and.returnValue({ contains: () => true });
    // Leaving the lasso puts the container and dragging back the way it found them.
    map.getContainer.and.returnValue(document.createElement('div'));
    map.dragging = { enable: () => {}, disable: () => {} };
    cluster = jasmine.createSpyObj('markerClusterGroup', ['addLayer', 'removeLayer']);
    (component as any).map = map;
    (component as any).markerClusterGroup = cluster;

    // The component builds its own markers from these, exactly as it does against a live map.
    service.projects.set([projectA, projectB]);
    fixture.detectChanges();

    markerA = (component as any).markersMap.get(1);
    markerB = (component as any).markersMap.get(2);
    cluster.addLayer.calls.reset();
    map.addLayer.calls.reset();
  });

  it('pops the selected marker out of the cluster group onto its own pane', () => {
    component.selectProject(projectA);
    fixture.detectChanges();

    expect(cluster.removeLayer).toHaveBeenCalledWith(markerA);
    const clone = popped();
    expect(clone.options.pane).toBe('selected-marker');
    expect(clone.getLatLng().equals(markerA.getLatLng())).toBeTrue();
    expect(iconClass(clone)).toContain('demi-marker--selected');
    expect(iconClass(clone)).toContain('demi-marker--arriving');
    expect(host().classList.contains('demi-map--selection')).toBeTrue();
  });

  it('keeps the popped marker above a project stacked on the same point', () => {
    // The "Ajax Mine" case: a twin on the identical centroid. The pane, not a deep zoom, separates
    // them, so the twin stays clustered and untouched.
    const twin = project(undefined, { id: 3, name: 'Twin', centroid: [-123, 49], eaCertificate: null });
    service.projects.set([projectA, projectB, twin]);
    fixture.detectChanges();

    component.selectProject(projectA);
    fixture.detectChanges();

    expect(popped().options.pane).toBe('selected-marker');
    expect(cluster.removeLayer).not.toHaveBeenCalledWith((component as any).markersMap.get(3));
    expect(map.flyTo).not.toHaveBeenCalled();
  });

  it('hands the original back to the cluster and drops the dim on deselect', () => {
    component.selectProject(projectA);
    fixture.detectChanges();
    const clone = popped();

    component.clearSelection();
    fixture.detectChanges();

    expect(map.removeLayer).toHaveBeenCalledWith(clone);
    expect(cluster.addLayer).toHaveBeenCalledWith(markerA);
    expect(host().classList.contains('demi-map--selection')).toBeFalse();
  });

  it('moves the pop-out when the selection changes', () => {
    component.selectProject(projectA);
    fixture.detectChanges();
    component.selectProject(projectB);
    fixture.detectChanges();

    expect(cluster.addLayer).toHaveBeenCalledWith(markerA);
    expect(cluster.removeLayer).toHaveBeenCalledWith(markerB);
    expect(popped().getLatLng().equals(markerB.getLatLng())).toBeTrue();
  });

  it('centres a marker that is already in view, so every pick lands in the same place', () => {
    component.selectProject(projectA);
    fixture.detectChanges();

    expect(map.panTo).toHaveBeenCalledWith(markerA.getLatLng());
    expect(map.flyTo).not.toHaveBeenCalled();
  });

  it('pans, never zooms, to a marker outside the viewport', () => {
    map.getBounds.and.returnValue({ contains: () => false });

    component.selectProject(projectA);
    fixture.detectChanges();

    expect(map.panTo).toHaveBeenCalledWith(markerA.getLatLng());
    expect(map.flyTo).not.toHaveBeenCalled();
  });

  it('flies in only from a province-wide view, and only to zoom 8', () => {
    map.getZoom.and.returnValue(5);

    component.selectProject(projectA);
    fixture.detectChanges();

    expect(map.flyTo).toHaveBeenCalledWith(markerA.getLatLng(), 8);
    // The fly-in already centres the marker, so it must not be followed by a pan.
    expect(map.panTo).not.toHaveBeenCalled();
  });

  it('takes the popped marker away when a filter drops the selected project', () => {
    component.selectProject(projectA);
    fixture.detectChanges();
    const clone = popped();

    service.projects.set([projectB]);
    fixture.detectChanges();

    expect(map.removeLayer).toHaveBeenCalledWith(clone);
    expect(host().classList.contains('demi-map--selection')).toBeFalse();
  });

  it('does nothing on the map when the project has no marker', () => {
    service.selectProject(homeless);
    fixture.detectChanges();

    expect(map.addLayer).not.toHaveBeenCalled();
    expect(host().classList.contains('demi-map--selection')).toBeFalse();
  });

  // --- The four deselect doors ---------------------------------------------------------------

  it('deselects when the selected row is clicked again', () => {
    row(1).click();
    fixture.detectChanges();
    expect(service.selectedProject()?.id).toBe(1);

    row(1).click();
    fixture.detectChanges();
    expect(service.selectedProject()).toBeNull();
  });

  it('clears the selection on Escape, and lets a lasso draw keep Escape', () => {
    component.selectProject(projectA);
    component.lassoActive.set(true);
    service.lassoPolygon.set([[-124, 48], [-122.5, 48], [-123.4, 49.5]]);

    component.onEscape();
    expect(service.lassoPolygon()).toBeNull();
    expect(service.selectedProject()?.id).toBe(1);

    component.onEscape();
    expect(service.selectedProject()).toBeNull();
  });

  it('clears the selection on a map background click, unless the lasso is armed', () => {
    component.selectProject(projectA);
    component.lassoActive.set(true);

    (component as any).onMapClick();
    expect(service.selectedProject()?.id).toBe(1);

    component.lassoActive.set(false);
    (component as any).onMapClick();
    expect(service.selectedProject()).toBeNull();
  });

  it('clears from the card ✕ and puts focus back on the rail row', () => {
    row(1).click();
    fixture.detectChanges();

    const close = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('button[aria-label="Clear selection"]')!;
    close.click();
    fixture.detectChanges();

    expect(service.selectedProject()).toBeNull();
    expect(document.activeElement).toBe(row(1));
  });

  it('marks the selected row for assistive tech, not colour alone', () => {
    expect(row(1).getAttribute('aria-selected')).toBe('false');

    component.selectProject(projectA);
    fixture.detectChanges();

    expect(row(1).getAttribute('aria-selected')).toBe('true');
    expect(row(1).classList.contains('kv-row--selected')).toBeTrue();
    expect(row(2).getAttribute('aria-selected')).toBe('false');
  });
});

describe('MapExplorerComponent lasso chip and save button', () => {
  let fixture: ComponentFixture<MapExplorerComponent>;
  let service: RegistryStateService;
  let userdata: UserdataService;

  beforeEach(async () => {
    spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(new Response(JSON.stringify([{ searchResults: [] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    );

    await TestBed.configureTestingModule({
      imports: [MapExplorerComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), provideRouter([])]
    }).compileComponents();

    fixture = TestBed.createComponent(MapExplorerComponent);
    spyOn(fixture.componentInstance as any, 'initMap');
    service = TestBed.inject(RegistryStateService);
    userdata = TestBed.inject(UserdataService);
  });

  it('shows the saved area name on the chip after applying it', () => {
    fixture.componentInstance.applySavedLasso(PEACE_VALLEY);
    fixture.detectChanges();

    const chip = fixture.componentInstance.activeFilters().find(f => f.id === 'lasso:area');
    expect(chip?.label).toBe('Peace Valley');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Peace Valley');
  });

  it('falls back to "Lasso area" for an unnamed freehand draw', () => {
    service.lassoPolygon.set([[-124, 48], [-122.5, 48], [-123.4, 49.5]]);
    fixture.detectChanges();

    const chip = fixture.componentInstance.activeFilters().find(f => f.id === 'lasso:area');
    expect(chip?.label).toBe('Lasso area');
  });

  it('disables Save and labels it "Saving…" while saveLasso is pending', async () => {
    service.isAuthenticated.set(true);
    service.lassoPolygon.set([[-124, 48], [-122.5, 48], [-123.4, 49.5]]);
    fixture.componentInstance.savingLasso.set(true);
    fixture.componentInstance.lassoName.set('New Area');
    fixture.detectChanges();

    let resolveSave!: (v: boolean) => void;
    const deferred = new Promise<boolean>(resolve => { resolveSave = resolve; });
    spyOn(userdata, 'saveLasso').and.returnValue(deferred);

    const pending = fixture.componentInstance.saveLasso();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const saveButton = Array.from(el.querySelectorAll('button')).find(b => b.textContent?.trim().includes('Saving'));
    expect(fixture.componentInstance.savingArea()).toBeTrue();
    expect(saveButton?.hasAttribute('disabled')).toBeTrue();
    expect(saveButton?.textContent?.trim()).toBe('Saving…');

    resolveSave(true);
    await pending;
    fixture.detectChanges();

    expect(fixture.componentInstance.savingArea()).toBeFalse();
    expect(service.lassoLabel()).toBe('New Area');
  });

  it('Enter in the name field submits the form and saves, via ngSubmit', async () => {
    service.isAuthenticated.set(true);
    service.lassoPolygon.set([[-124, 48], [-122.5, 48], [-123.4, 49.5]]);
    fixture.componentInstance.savingLasso.set(true);
    fixture.componentInstance.lassoName.set('Enter Area');
    fixture.detectChanges();

    spyOn(userdata, 'saveLasso').and.returnValue(Promise.resolve(true));

    const form = (fixture.nativeElement as HTMLElement).querySelector('form');
    expect(form).withContext('name-this-area form must exist for Enter to submit it').not.toBeNull();
    form!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();

    expect(userdata.saveLasso).toHaveBeenCalledWith('Enter Area', jasmine.any(Array));
  });
});
