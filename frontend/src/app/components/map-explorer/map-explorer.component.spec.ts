import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MapExplorerComponent } from './map-explorer.component';
import { RegistryStateService } from '../../services/registry-state.service';
import { Project } from '../../models/registry.models';

type Wildfire = NonNullable<NonNullable<Project['sources']>['wildfire']>;

const project = (wildfire?: Wildfire): Project => ({
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
  ...(wildfire ? { sources: { wildfire } } : {})
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
});
