import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { MapExplorerComponent, invasivesCql } from './map-explorer.component';
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

describe('MapExplorerComponent layers badge', () => {
  let fixture: ComponentFixture<MapExplorerComponent>;
  let component: MapExplorerComponent;
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
    component = fixture.componentInstance;
    spyOn(component as any, 'initMap');
    service = TestBed.inject(RegistryStateService);
    service.activeBoundaryLayers.set([]);
  });

  // The Filters button has its own '.pill--info' badge, so scope to the button labelled Layers.
  const layersBadge = () => {
    const button = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'))
      .find(btn => (btn.textContent ?? '').includes('Layers'));
    return button?.querySelector('.pill--info')?.textContent?.trim() ?? null;
  };

  it('renders the count of boundary layers plus the wildfire and invasives toggles', () => {
    fixture.detectChanges();
    expect(layersBadge()).toBeNull();

    component.toggleWildfires();
    component.toggleInvasives();
    fixture.detectChanges();
    expect(layersBadge()).toBe('2');

    component.toggleLayer('regions');
    fixture.detectChanges();
    expect(layersBadge()).toBe('3');
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

describe('MapExplorerComponent invasive species overlay', () => {
  let fixture: ComponentFixture<MapExplorerComponent>;
  let component: MapExplorerComponent;
  let map: any;
  let fetchSpy: jasmine.Spy;

  const observation = {
    type: 'FeatureCollection',
    features: [{
      properties: {
        INVASIVE_PLANT: 'Japanese knotweed (Reynoutria / Fallopia japonica)',
        INVASIVE_PLANT_POSITIVE: 'Japanese knotweed (Reynoutria / Fallopia japonica)',
        INVASIVE_PLANT_NEGATIVE: null,
        ACTIVITY_DATE: '2024-12-17Z'
      }
    }]
  };

  const answer = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  }));

  /** Only the WMS reads, so the registry service's own start-up fetches are not mistaken for one. */
  const featureInfoUrls = () => fetchSpy.calls.all()
    .map(call => String(call.args[0]))
    .filter(url => url.includes('GetFeatureInfo'));

  const click = () => (component as any).onMapClick({ latlng: { lat: 49.67, lng: -125.04 } });

  /** The answer lands a microtask after the body is read, which whenStable alone can miss. */
  const settle = async () => {
    await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve));
  };

  const xml = (matched: number) =>
    `<wfs:FeatureCollection numberMatched="${matched}" numberReturned="0"></wfs:FeatureCollection>`;

  const xmlAnswer = (body: string) => Promise.resolve(new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/xml' }
  }));

  /** The count goes out as two hits reads, one per rule of the style; answer them apart. */
  const hitsAnswering = (present: number, absent: number) => fetchSpy.and.callFake((input: any) => {
    const filter = new URL(String(input)).searchParams.get('CQL_FILTER') ?? '';
    return xmlAnswer(xml(filter.includes('IS NOT NULL') ? present : absent));
  });

  /** Types a species and waits out the 400 ms debounce the input applies. */
  const type = async (species: string) => {
    component.setInvasivesSpecies({ target: { value: species } } as unknown as Event);
    await new Promise(resolve => setTimeout(resolve, 450));
    await settle();
  };

  const SPECIES_LIST = ["Baby's breath (Gypsophila paniculata)", 'Bull thistle (Cirsium vulgare)'];

  /** The build-time species asset on its own URL; everything else keeps the default stub. */
  const withSpeciesList = () => fetchSpy.and.callFake((input: any) =>
    String(input).includes('invasive-species.json')
      ? answer({ generated: '2026-09-09', source: 'https://catalogue.data.gov.bc.ca', species: SPECIES_LIST })
      : answer([{ searchResults: [] }]));

  const speciesListUrls = () => fetchSpy.calls.all()
    .map(call => String(call.args[0]))
    .filter(url => url.includes('data/invasive-species.json'));

  const options = () => Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll('#demi-invasives-species-options option')
  ).map(option => (option as HTMLOptionElement).value);

  const speciesBox = () =>
    (fixture.nativeElement as HTMLElement).querySelector('#demi-invasives-species') as HTMLInputElement | null;

  beforeEach(async () => {
    fetchSpy = spyOn(window, 'fetch').and.callFake(() => answer([{ searchResults: [] }]));

    await TestBed.configureTestingModule({
      imports: [MapExplorerComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), provideRouter([])]
    }).compileComponents();

    fixture = TestBed.createComponent(MapExplorerComponent);
    component = fixture.componentInstance;
    spyOn(component as any, 'initMap');

    map = jasmine.createSpyObj('map',
      ['addLayer', 'removeLayer', 'getSize', 'getBounds', 'latLngToContainerPoint', 'openPopup', 'on', 'remove']);
    map.getSize.and.returnValue({ x: 800, y: 600 });
    map.getBounds.and.returnValue({
      getSouthWest: () => ({ lat: 49.0, lng: -126.0 }),
      getNorthEast: () => ({ lat: 50.0, lng: -124.0 })
    });
    map.latLngToContainerPoint.and.returnValue({ x: 400, y: 300 });
    (component as any).map = map;
    fixture.detectChanges();
    map.addLayer.calls.reset();
  });

  it('puts the DataBC WMS tiles on the map when the overlay is switched on', () => {
    component.toggleInvasives();
    fixture.detectChanges();

    const layer = map.addLayer.calls.mostRecent().args[0];
    expect(layer.wmsParams.layers).toBe('pub:WHSE_FOREST_VEGETATION.IBC_INVASIVE_SPECIES_OBS_SP');
    expect(layer.wmsParams.format).toBe('image/png');
    expect(layer.wmsParams.transparent).toBe(true);
    expect(layer.options.attribution).toContain('Open Government Licence');
  });

  it('paints the observations in the danger red, not the green DataBC ships', () => {
    component.toggleInvasives();
    fixture.detectChanges();

    const sld = map.addLayer.calls.mostRecent().args[0].wmsParams.SLD_BODY as string;
    expect(sld).toContain('#ce3e39');
    expect(sld).not.toContain('#009100');
    expect(sld).toContain('PolygonSymbolizer');
    expect(sld).toContain('PointSymbolizer');
    // Tiles go out as GET, so the style has to stay small enough to ride in a query string.
    expect(encodeURIComponent(sld).length).toBeLessThan(2048);
  });

  it('takes the same layer off the map when the overlay is switched off', () => {
    component.toggleInvasives();
    fixture.detectChanges();
    const layer = map.addLayer.calls.mostRecent().args[0];

    component.toggleInvasives();
    fixture.detectChanges();

    expect(map.removeLayer).toHaveBeenCalledWith(layer);
  });

  it('asks the WMS about the clicked pixel while the overlay is on', () => {
    component.toggleInvasives();
    fixture.detectChanges();

    click();

    const url = featureInfoUrls()[0];
    expect(url).withContext('a click with the overlay on must query the WMS').toBeDefined();
    expect(url).toContain('REQUEST=GetFeatureInfo');
    expect(url).toContain('WHSE_FOREST_VEGETATION.IBC_INVASIVE_SPECIES_OBS_SP');
    expect(url).toContain('CRS=EPSG%3A3857');
    expect(url).toContain('I=400');
    expect(url).toContain('J=300');
    // Without the same style, the server answers from its own, which draws nothing when zoomed in.
    expect(new URL(url).searchParams.get('SLD_BODY')).toContain('#ce3e39');

    // The server rejects a bbox whose corners are the wrong way round: minx,miny,maxx,maxy.
    const [minX, minY, maxX, maxY] = (new URL(url).searchParams.get('BBOX') ?? '').split(',').map(Number);
    expect([minX, minY, maxX, maxY].every(Number.isFinite)).toBeTrue();
    expect(minX).toBeLessThan(maxX);
    expect(minY).toBeLessThan(maxY);
  });

  it('asks nothing while the overlay is off', () => {
    click();

    expect(featureInfoUrls()).toEqual([]);
  });

  it('names the species, the date and the presence in the popup', async () => {
    component.toggleInvasives();
    fixture.detectChanges();
    fetchSpy.and.callFake(() => answer(observation));

    click();
    await settle();

    const card = map.openPopup.calls.mostRecent().args[0].getContent() as HTMLElement;
    expect(card.textContent).toContain('Japanese knotweed');
    expect(card.textContent).toContain('Reynoutria / Fallopia japonica');
    expect(card.textContent).toContain('2024-12-17');
    expect(card.textContent).toContain('Present');
  });

  it('reads the species list once, the first time the overlay goes on', async () => {
    withSpeciesList();

    component.toggleInvasives();
    fixture.detectChanges();
    await settle();
    expect(component.invasivesSpeciesList()).toEqual(SPECIES_LIST);

    component.toggleInvasives();
    fixture.detectChanges();
    component.toggleInvasives();
    fixture.detectChanges();
    await settle();

    expect(speciesListUrls().length).withContext('the asset never changes inside one visit').toBe(1);
  });

  it('offers every species as an option under the box', async () => {
    withSpeciesList();
    component.layersOpen.set(true);
    component.toggleInvasives();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    expect(speciesBox()!.getAttribute('list')).toBe('demi-invasives-species-options');
    expect(options()).toEqual(SPECIES_LIST);
  });

  it('filters on the whole name when an option is chosen', async () => {
    withSpeciesList();
    component.toggleInvasives();
    fixture.detectChanges();
    const layer = map.addLayer.calls.mostRecent().args[0];

    await type(SPECIES_LIST[0]);

    expect(layer.wmsParams.CQL_FILTER)
      .toBe("INVASIVE_PLANT ILIKE '%Baby''s breath (Gypsophila paniculata)%'");
  });

  it('says All species until a name is typed', async () => {
    component.layersOpen.set(true);
    component.toggleInvasives();
    fixture.detectChanges();
    expect(component.invasivesMatchLabel()).toBe('All species');

    hitsAnswering(479, 218);
    await type('baby');
    fixture.detectChanges();
    expect(component.invasivesMatchLabel()).toBe('479 present, 218 absent');

    await type('  ');
    fixture.detectChanges();
    expect(component.invasivesMatchLabel()).toBe('All species');
  });

  it('quotes a species safely into CQL', () => {
    expect(invasivesCql("Baby's breath")).toBe("INVASIVE_PLANT ILIKE '%Baby''s breath%'");
    expect(invasivesCql('50%_knap')).toBe("INVASIVE_PLANT ILIKE '%50\\%\\_knap%'");
    expect(invasivesCql('   ')).toBe('');
  });

  it('shows the species box only while the overlay is on', () => {
    component.layersOpen.set(true);
    fixture.detectChanges();
    expect(speciesBox()).toBeNull();

    component.toggleInvasives();
    fixture.detectChanges();

    expect(speciesBox()).not.toBeNull();
    expect(speciesBox()!.placeholder).toBe("e.g. Baby's breath");
  });

  it('puts the typed species on the tiles and takes it off when cleared', async () => {
    component.toggleInvasives();
    fixture.detectChanges();
    const layer = map.addLayer.calls.mostRecent().args[0];

    await type('baby');
    expect(layer.wmsParams.CQL_FILTER).toBe("INVASIVE_PLANT ILIKE '%baby%'");

    await type('');
    expect(layer.wmsParams.CQL_FILTER).toBeUndefined();
  });

  it('asks the WMS about the filtered set, not every observation', async () => {
    component.toggleInvasives();
    fixture.detectChanges();
    await type("Baby's breath");

    click();

    const asked = new URL(featureInfoUrls()[0]).searchParams.get('CQL_FILTER');
    expect(asked).toBe("INVASIVE_PLANT ILIKE '%Baby''s breath%'");
  });

  it('counts what the species matches', async () => {
    component.toggleInvasives();
    component.layersOpen.set(true);
    fixture.detectChanges();
    hitsAnswering(479, 218);

    await type('baby');
    fixture.detectChanges();

    expect(component.invasivesMatches()).toEqual({ present: 479, absent: 218 });
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('479 present, 218 absent');
  });

  it('ignores a count that lands after a newer species was typed', async () => {
    component.toggleInvasives();
    fixture.detectChanges();

    const stale: ((answer: Response) => void)[] = [];
    fetchSpy.and.callFake(() => new Promise<Response>(resolve => stale.push(resolve)));
    await type('baby');

    hitsAnswering(3, 1);
    await type('knapweed');
    expect(component.invasivesMatches()).toEqual({ present: 3, absent: 1 });

    stale.forEach(resolve => resolve(new Response(xml(697), { status: 200 })));
    await new Promise(resolve => setTimeout(resolve, 50));
    await settle();

    expect(component.invasivesMatches())
      .withContext('the older answer must not win')
      .toEqual({ present: 3, absent: 1 });
  });

  it('says the read failed rather than leaving the click looking ignored', async () => {
    component.toggleInvasives();
    fixture.detectChanges();
    // GeoServer answers an error with an XML exception report, so the JSON parse rejects.
    fetchSpy.and.callFake(() => Promise.resolve(new Response('<ServiceExceptionReport/>', {
      status: 200,
      headers: { 'Content-Type': 'application/xml' }
    })));

    click();
    await settle();

    const card = map.openPopup.calls.mostRecent().args[0].getContent() as HTMLElement;
    expect(card.textContent).toBe('Could not load observation details.');
  });

  it('draws a confirmed absence in the success green, not as an infestation', () => {
    component.toggleInvasives();
    fixture.detectChanges();

    const sld = map.addLayer.calls.mostRecent().args[0].wmsParams.SLD_BODY as string;
    expect(sld).toContain('INVASIVE_PLANT_POSITIVE');
    expect(sld).toContain('#42814a');
    expect(sld.match(/<Rule>/g)?.length).withContext('one rule per presence state').toBe(2);
    // Both rules fill, so an absence stays visible, but only the red one reads as an infestation.
    const absence = sld.slice(sld.indexOf('ElseFilter'));
    expect(sld.indexOf('#ce3e39')).toBeLessThan(sld.indexOf('ElseFilter'));
    expect(absence).not.toContain('#ce3e39');
    expect(absence).toContain('<CssParameter name="fill-opacity">0.45</CssParameter>');
    // Colour alone would fail WCAG 1.4.1, so absences also read as dashed outlines and hollow points.
    const presence = sld.slice(0, sld.indexOf('ElseFilter'));
    expect(absence).toContain('<CssParameter name="stroke-dasharray">4 2</CssParameter>');
    expect(presence).not.toContain('stroke-dasharray');
    const absenceMark = absence.slice(absence.indexOf('<Mark>'), absence.indexOf('</Mark>'));
    expect(absenceMark).withContext('absence points are hollow').not.toContain('<Fill>');
    expect(absenceMark).toContain('<CssParameter name="stroke">#42814a</CssParameter>');
  });

  it('says so when the pixel carries no observation', async () => {
    component.toggleInvasives();
    fixture.detectChanges();
    fetchSpy.and.callFake(() => answer({ type: 'FeatureCollection', features: [] }));

    click();
    await settle();

    const card = map.openPopup.calls.mostRecent().args[0].getContent() as HTMLElement;
    expect(card.textContent).toBe('No observation here.');
  });
});
