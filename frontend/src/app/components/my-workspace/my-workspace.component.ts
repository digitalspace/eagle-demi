import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, computed, effect, inject, linkedSignal, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import type * as Leaflet from 'leaflet';
import 'leaflet';
import { RegistryStateService, visibleRoles } from '../../services/registry-state.service';
import { UserdataService, SavedLasso } from '../../services/userdata.service';
import { LinksService, ShortLink, isMine } from '../../services/links.service';
import { Prefs, LANDING_OPTIONS, PER_PAGE_OPTIONS, DEFAULT_PREFS, readPrefs, writePrefs } from '../../shell/prefs';

const L = (window as unknown as { L: typeof Leaflet }).L;

@Component({
  selector: 'app-my-workspace',
  standalone: true,
  imports: [RouterLink, DatePipe],
  templateUrl: './my-workspace.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class MyWorkspaceComponent implements OnInit, OnDestroy {
  service = inject(RegistryStateService);
  userdata = inject(UserdataService);
  links = inject(LinksService);
  private router = inject(Router);

  readonly linkButtonStyle = 'background: none; border: none; padding: 0; font: var(--typography-regular-small-body); color: var(--surface-color-primary-default); text-decoration: underline; cursor: pointer;';
  readonly landingOptions = LANDING_OPTIONS;
  readonly perPageOptions = PER_PAGE_OPTIONS;

  private token = computed(() => this.service.isAuthenticated() ? this.service.keycloak?.tokenParsed : null);

  name = computed(() => this.token()?.name || '—');
  email = computed(() => this.token()?.email || '—');
  idir = computed(() => this.token()?.idir_username || this.token()?.preferred_username || '—');
  roles = computed<string[]>(() => visibleRoles(this.token()?.realm_access?.roles));
  groups = computed<string[]>(() => this.token()?.groups || []);

  initials = computed(() => {
    const words: string[] = String(this.token()?.name || '').split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map(w => w[0].toUpperCase()).join('') || '—';
  });

  private me = computed(() => this.token()?.preferred_username || '');
  myLinks = computed<ShortLink[]>(() => this.links.links().filter(link => isMine(link, this.me())));

  /** Server copy when `/me/data` has answered, this browser's otherwise; edits override both. */
  prefs = linkedSignal<Prefs>(() => this.userdata.prefs() ?? readPrefs());

  private mapHost = viewChild<ElementRef<HTMLElement>>('miniMap');
  private map: Leaflet.Map | null = null;
  private ringLayer: Leaflet.Polygon | null = null;
  private sizeObserver?: ResizeObserver;

  private selectedSlug = signal<string | null>(null);
  /** Falls back to the first area, so the overlay is filled in as soon as the areas load. */
  selected = computed<SavedLasso | null>(() => {
    const areas = this.userdata.lassos();
    return areas.find(area => area.slug === this.selectedSlug()) ?? areas[0] ?? null;
  });

  constructor() {
    // The map host only exists once an area has loaded, so this waits for the view child rather
    // than building the map in ngAfterViewInit.
    effect(() => {
      const host = this.mapHost()?.nativeElement;
      const area = this.selected();
      if (!host || !area) return;
      this.map ??= this.initMap(host);
      if (this.ringLayer) this.map.removeLayer(this.ringLayer);
      this.ringLayer = L.polygon(area.ring.map(([lng, lat]) => [lat, lng] as [number, number]),
        { color: '#013366', weight: 3, fillColor: '#013366', fillOpacity: 0.1 }).addTo(this.map);
      this.map.fitBounds(this.ringLayer.getBounds(), { padding: [16, 16] });
    });
  }

  ngOnInit() {
    if (!this.service.isAuthenticated()) return;
    this.userdata.loadMyData();
    this.links.load();
  }

  ngOnDestroy() {
    this.sizeObserver?.disconnect();
    this.map?.remove();
  }

  private initMap(host: HTMLElement): Leaflet.Map {
    const map = L.map(host, { zoomControl: false, preferCanvas: true }).setView([54.0, -125.0], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(map);
    // Leaflet keeps the size it measured at init, and the panel is laid out after first paint.
    this.sizeObserver = new ResizeObserver(() => map.invalidateSize());
    this.sizeObserver.observe(host);
    return map;
  }

  select(area: SavedLasso) {
    this.selectedSlug.set(area.slug);
  }

  /** The map draws whatever this signal holds, so the shape is already there on arrival. */
  applyOnMap(area: SavedLasso) {
    this.service.lassoPolygon.set(area.ring);
    this.service.lassoLabel.set(area.name);
    return this.router.navigate(['/map']);
  }

  deleteLasso(area: SavedLasso) {
    // Deleting the selected area hands the overlay to the next one down, or the one above when it
    // was last; deleting any other area leaves the selection where it is.
    if (area.slug === this.selected()?.slug) {
      const areas = this.userdata.lassos();
      const i = areas.findIndex(a => a.slug === area.slug);
      this.selectedSlug.set((areas[i + 1] ?? areas[i - 1])?.slug ?? null);
    }
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
