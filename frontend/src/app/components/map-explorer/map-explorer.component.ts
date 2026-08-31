import { Component, OnInit, OnDestroy, AfterViewInit, inject, effect, signal, computed, untracked, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { RegistryStateService } from '../../services/registry-state.service';
import { Project } from '../../models/registry.models';
import { readPrefs } from '../../shell/prefs';
import type * as Leaflet from 'leaflet';
import 'leaflet';
import 'leaflet.markercluster';
// The plugin attaches markerClusterGroup to the module object leaflet also publishes as
// window.L. A namespace import is the bundler's frozen copy and misses it in production.
const L = (window as unknown as { L: typeof Leaflet }).L;

/** One checkbox row inside the Filters drawer. */
interface FilterOption { value: string; label: string; checked: boolean }
interface FilterSection { id: string; label: string; searchable: boolean; searchValue: string; options: FilterOption[] }
/** One `key: value` row of the detail card, tagged with the system the value came from. */
interface FieldRow { key: string; value: string; source: 'TRACK' | 'EPIC' | 'DEMI'; long: boolean }

@Component({
  selector: 'app-map-explorer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './map-explorer.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class MapExplorerComponent implements OnInit, OnDestroy, AfterViewInit {
  service = inject(RegistryStateService);
  private router = inject(Router);

  availableRegions = ['Vancouver Island', 'Lower Mainland', 'Thompson', 'Kootenay', 'Cariboo', 'Skeena', 'Omineca', 'Okanagan', 'Peace'];

  public map: any = null;
  private regionsLayer: any = null;
  private boundariesLayers = new Map<string, any>();
  private markerClusterGroup: any = null;
  private markersMap = new Map<any, any>();
  private wildfireLayerGroup: any = null;

  showWildfires = signal<boolean>(false);

  // --- Left rail and detail card -------------------------------------------------------------
  filtersOpen = signal<boolean>(false);
  layersOpen = signal<boolean>(false);
  detailsExpanded = signal<boolean>(false);
  sourceTab = signal<'all' | 'track' | 'epic' | 'demi'>('all');
  sortBy = signal<'relevance' | 'name'>('relevance');
  /** Rows added per "Load N more" in the left rail — the profile's "Results per page" pref. */
  private pageSize = readPrefs().perPage;
  visibleCount = signal<number>(this.pageSize);
  openSections = signal<string[]>(['sector']);
  sectorQuery = signal<string>('');
  copiedId = signal<boolean>(false);

  readonly sourceTabs: { id: 'all' | 'track' | 'epic' | 'demi'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'track', label: 'Track' },
    { id: 'epic', label: 'EPIC' },
    { id: 'demi', label: 'DEMI' }
  ];

  readonly overlayRows: { id: string; label: string }[] = [
    { id: 'regions', label: 'Environmental regions' },
    { id: 'regionalDistricts', label: 'Regional districts' },
    { id: 'municipalities', label: 'Municipalities' },
    { id: 'electoralDistricts', label: 'Electoral districts' }
  ];

  // Custom searchable select signals per category
  activeDistrictQuery = signal<string>('');
  activeMuniQuery = signal<string>('');
  activeElectoralQuery = signal<string>('');

  regionalDistrictNames = computed(() => {
    const cache = this.service.loadedBoundariesGeoJSON();
    const data = cache['regionalDistricts'] || [];
    return data.map((b: any) => b.name).sort((a: string, b: string) => a.localeCompare(b));
  });

  municipalityNames = computed(() => {
    const cache = this.service.loadedBoundariesGeoJSON();
    const data = cache['municipalities'] || [];
    return data.map((b: any) => b.name).sort((a: string, b: string) => a.localeCompare(b));
  });

  electoralDistrictNames = computed(() => {
    const cache = this.service.loadedBoundariesGeoJSON();
    const data = cache['electoralDistricts'] || [];
    return data.map((b: any) => b.name).sort((a: string, b: string) => a.localeCompare(b));
  });

  filteredRegionalDistricts = computed(() => {
    const q = this.activeDistrictQuery().toLowerCase().trim();
    const names = this.regionalDistrictNames();
    if (!q) return names;
    return names.filter((name: string) => name.toLowerCase().includes(q));
  });

  filteredMunicipalities = computed(() => {
    const q = this.activeMuniQuery().toLowerCase().trim();
    const names = this.municipalityNames();
    if (!q) return names;
    return names.filter((name: string) => name.toLowerCase().includes(q));
  });

  filteredElectoralDistricts = computed(() => {
    const q = this.activeElectoralQuery().toLowerCase().trim();
    const names = this.electoralDistrictNames();
    if (!q) return names;
    return names.filter((name: string) => name.toLowerCase().includes(q));
  });

  // --- Result list ---------------------------------------------------------------------------

  sortedProjects = computed(() => {
    const list = this.service.filteredProjects();
    if (list === null) return null;
    if (this.sortBy() !== 'name') return list;
    return [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  });

  pagedProjects = computed(() => (this.sortedProjects() || []).slice(0, this.visibleCount()));
  canLoadMore = computed(() => (this.sortedProjects() || []).length > this.visibleCount());
  noResults = computed(() => this.sortedProjects()?.length === 0);
  resultCount = computed(() => this.sortedProjects()?.length ?? 0);

  resultSummary = computed(() =>
    `${this.service.resultCountLabel(this.sortedProjects()?.length, this.service.projectMatchCount())} projects`
  );

  /** Sectors present in the loaded corpus — a query with no hits gets offered real ones. */
  suggestions = computed(() =>
    this.service.sectorOptions().slice(0, 3).map(o => o.label)
  );

  // --- Filters drawer ------------------------------------------------------------------------

  /** Names ticked in one boundary layer. Each layer has its own set; they never overwrite. */
  private boundarySelection(layer: string): Set<string> {
    return this.service.boundaryFilter()[layer] || new Set<string>();
  }

  private boundarySection(id: string, label: string, names: string[], query: string): FilterSection {
    const active = this.boundarySelection(id);
    return {
      id,
      label,
      searchable: true,
      searchValue: query,
      // ponytail: 50-row cap, the drawer's own search box is the way past it. Virtual scrolling
      // if the boundary lists ever outgrow that.
      options: names.slice(0, 50).map(name => ({ value: name, label: name, checked: active.has(name) }))
    };
  }

  filterSections = computed<FilterSection[]>(() => {
    const gating = this.service.gatingFilter();
    const sector = this.service.sectorFilter();
    const region = this.service.regionFilter();
    const sectorQuery = this.sectorQuery().toLowerCase().trim();

    return [
      {
        id: 'gating', label: 'Gating state', searchable: false, searchValue: '',
        options: [
          { value: 'admitted', label: 'Admitted', checked: gating.has('admitted') },
          { value: 'staged', label: 'Staged', checked: gating.has('staged') }
        ]
      },
      {
        id: 'sector', label: 'Sector', searchable: true, searchValue: this.sectorQuery(),
        options: this.service.sectorOptions()
          .filter(o => !sectorQuery || o.label.toLowerCase().includes(sectorQuery))
          .map(o => ({ value: o.value, label: `${o.label} (${o.count})`, checked: sector.has(o.value) }))
      },
      {
        id: 'region', label: 'Environmental region', searchable: false, searchValue: '',
        options: this.availableRegions.map(r => ({ value: r, label: r, checked: region.has(r) }))
      },
      this.boundarySection('regionalDistricts', 'Regional district', this.filteredRegionalDistricts(), this.activeDistrictQuery()),
      this.boundarySection('municipalities', 'Municipality', this.filteredMunicipalities(), this.activeMuniQuery()),
      this.boundarySection('electoralDistricts', 'Electoral district', this.filteredElectoralDistricts(), this.activeElectoralQuery())
    ];
  });

  /** One chip per selected value. `id` is `section:value`, so a chip removes only itself. */
  activeFilters = computed<{ id: string; label: string }[]>(() => {
    const rows: { id: string; label: string }[] = [];
    const push = (section: string, values: Iterable<string>, label: (v: string) => string = v => v) => {
      for (const value of values) rows.push({ id: `${section}:${value}`, label: label(value) });
    };
    push('gating', this.service.gatingFilter(), v => v === 'staged' ? 'Staged' : 'Admitted');
    push('sector', this.service.sectorFilter());
    push('region', this.service.regionFilter());
    for (const [layer, names] of Object.entries(this.service.boundaryFilter())) push(layer, names);
    return rows;
  });

  // --- Detail card ---------------------------------------------------------------------------

  /**
   * `key: value` rows for the selected project, tagged with where the value came from.
   *
   * Built by walking the metadata objects rather than from a fixed field list: the Track payload
   * is a checked-in export whose columns move, and a hard-coded list drifts into showing blanks.
   */
  fieldRows = computed<FieldRow[]>(() => {
    const p = this.service.selectedProject();
    if (!p) return [];

    const rows: FieldRow[] = [];
    const push = (source: FieldRow['source'], key: string, value: any) => {
      if (value === null || value === undefined || value === '') return;
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      // Past ~40 chars a right-aligned value wraps into a cramped column; the template stacks it.
      rows.push({ key, value: text, source, long: text.length > 40 });
    };

    for (const [key, value] of Object.entries(p.rawMetadata?.trackAttributes || {})) {
      push('TRACK', this.humanise(key), value);
    }
    // Track's own column, but it arrives on the mapped project rather than in `trackAttributes`.
    // `push` drops it when the project has no certificate.
    push('TRACK', 'EA Certificate', p.eaCertificate);
    for (const [key, value] of Object.entries(p.rawMetadata?.eagleAttributes || {})) {
      push('EPIC', this.humanise(key), value);
    }
    push('EPIC', 'Legacy Eagle id', p.legacyEagleId);

    push('DEMI', 'DEMI id', p.id);
    push('DEMI', 'Gating state', p.gatingState);
    push('DEMI', 'Region', p.region);
    push('DEMI', 'Regional district', p.regionalDistrict);
    push('DEMI', 'Municipality', p.municipality);
    push('DEMI', 'Electoral district', p.electoralDistrict);
    if (p.centroid) push('DEMI', 'Centroid (lon, lat)', `${p.centroid[0]}, ${p.centroid[1]}`);

    const wf = p.sources?.wildfire;
    if (wf) {
      const asOf = wf.lastCalculatedAt ? new Date(wf.lastCalculatedAt).toLocaleDateString() : '';
      push('DEMI', 'Nearby fires (50 km)', `${wf.activeCountWithin50km} active fires${asOf ? `, as of ${asOf}` : ''}`);
      push('DEMI', 'Fires of note', wf.firesOfNoteNearby > 0 ? 'Fires of Note Nearby' : 'None nearby');
      if (wf.nearestDistanceKm != null) push('DEMI', 'Nearest fire', `${wf.nearestDistanceKm} km`);
    }

    const tab = this.sourceTab();
    if (tab === 'all') return rows;
    const wanted = tab === 'track' ? 'TRACK' : tab === 'epic' ? 'EPIC' : 'DEMI';
    return rows.filter(r => r.source === wanted);
  });

  private humanise(key: string): string {
    const words = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
  }

  constructor() {
    // A new result set starts at page one; without this a narrower search keeps the old page depth.
    effect(() => {
      this.service.filteredProjects();
      this.sortBy();
      untracked(() => this.visibleCount.set(this.pageSize));
    });

    // Re-sync map markers whenever our filtered projects or role change!
    effect(() => {
      const filtered = this.service.filteredProjects() || [];
      this.syncMarkersToMap(filtered);
      setTimeout(() => this.updateViewportProjects(), 100);
    });

    // Load geometries for all active boundary layers
    effect(() => {
      const layers = this.service.activeBoundaryLayers();
      for (const bLayer of layers) {
        if (bLayer !== 'none' && bLayer !== 'regions') {
          this.service.loadBoundaryGeometry(bLayer, 'simplified');
        }
      }
    });

    // Re-render administrative boundaries whenever they change or are loaded!
    effect(() => {
      const layers = this.service.activeBoundaryLayers();
      const cache = this.service.loadedBoundariesGeoJSON(); // Synchronously track cache updates!
      const regionsGeojson = this.service.regionalBoundariesGeoJSON();
      
      if (!this.map) return;

      // Handle environmental regions ('regions' layer)
      if (layers.includes('regions')) {
        if (!regionsGeojson) {
          this.service.loadRegionalBoundaries();
        } else if (!this.regionsLayer) {
          this.loadRegionalBoundaries();
        }
      } else {
        if (this.regionsLayer) {
          try {
            this.map.removeLayer(this.regionsLayer);
          } catch (err) {
            console.warn('Error removing old regions layer:', err);
          }
          this.regionsLayer = null;
        }
      }

      // Handle other administrative layers
      const adminTypes = ['regionalDistricts', 'municipalities', 'electoralDistricts'];
      for (const type of adminTypes) {
        if (layers.includes(type)) {
          const boundaries = cache[type] || [];
          if (boundaries.length > 0) {
            untracked(() => {
              this.renderBoundaryShapes(boundaries, type);
            });
          }
        } else {
          const existing = this.boundariesLayers.get(type);
          if (existing) {
            try {
              this.map.removeLayer(existing);
            } catch (err) {
              console.warn(`Error removing old boundaries layer for ${type}:`, err);
            }
            this.boundariesLayers.delete(type);
          }
        }
      }
    });

    // Re-style administrative boundaries in-place whenever active filters change!
    effect(() => {
      this.service.boundaryFilter();
      untracked(() => {
        this.updateBoundaryLayersStyles();
      });
    });

    // Reactive effect to render or remove active B.C. Wildfires
    effect(() => {
      const active = this.showWildfires();
      if (!this.map) return;
      if (active) {
        this.loadWildfiresOnMap();
      } else if (this.wildfireLayerGroup) {
        try {
          this.map.removeLayer(this.wildfireLayerGroup);
        } catch (e) {}
        this.wildfireLayerGroup = null;
      }
    });
  }

  ngOnInit() {
    this.service.activePage.set('map');
    
    // Proactively load administrative names (without heavy geometries) so they are immediately searchable
    this.service.loadBoundaryGeometry('regionalDistricts', 'metadata');
    this.service.loadBoundaryGeometry('municipalities', 'metadata');
    this.service.loadBoundaryGeometry('electoralDistricts', 'metadata');
  }

  ngAfterViewInit() {
    setTimeout(() => {
      this.initMap();
    }, 50);
  }

  // --- Left rail and detail card handlers ----------------------------------------------------

  toggleFilters() { this.filtersOpen.set(!this.filtersOpen()); }
  toggleLayers() { this.layersOpen.set(!this.layersOpen()); }
  loadMore() { this.visibleCount.set(this.visibleCount() + this.pageSize); }

  isSectionOpen(id: string): boolean { return this.openSections().includes(id); }

  toggleSection(id: string) {
    const open = this.openSections();
    this.openSections.set(open.includes(id) ? open.filter(s => s !== id) : [...open, id]);
  }

  /** The search boxes only narrow the option list; they never change what is ticked. */
  onSectionSearch(id: string, event: Event) {
    const value = (event.target as HTMLInputElement).value;
    if (id === 'sector') this.sectorQuery.set(value);
    else if (id === 'regionalDistricts') this.activeDistrictQuery.set(value);
    else if (id === 'municipalities') this.activeMuniQuery.set(value);
    else if (id === 'electoralDistricts') this.activeElectoralQuery.set(value);
  }

  toggleFilterOption(sectionId: string, option: FilterOption) {
    this.toggleFilterValue(sectionId, option.value);
  }

  /** Remove one chip — a toggle, because the chip only exists while the value is selected. */
  clearFilter(id: string) {
    const split = id.indexOf(':');
    this.toggleFilterValue(id.slice(0, split), id.slice(split + 1));
  }

  clearFilters() {
    this.service.clearFilters();
    this.updateRegionsLayerStyle();
    this.updateBoundaryLayersStyles();
  }

  private toggleFilterValue(sectionId: string, value: string) {
    if (sectionId === 'gating') this.service.toggleFilterValue(this.service.gatingFilter, value);
    else if (sectionId === 'sector') this.service.toggleFilterValue(this.service.sectorFilter, value);
    else if (sectionId === 'region') this.setRegionFilter(value);
    else this.setBoundaryFilter(sectionId, value);
  }

  clearQuery() {
    this.service.searchQuery.set('');
    this.service.loadData();
  }

  applySuggestion(label: string) {
    this.service.searchQuery.set(label);
    this.service.loadData();
  }

  onSortChange(event: Event) {
    this.sortBy.set((event.target as HTMLSelectElement).value as 'relevance' | 'name');
  }

  toggleDetails() { this.detailsExpanded.set(!this.detailsExpanded()); }
  setSourceTab(tab: 'all' | 'track' | 'epic' | 'demi') { this.sourceTab.set(tab); }

  pillClass(state: string | undefined): string {
    return state === 'staged' ? 'pill--warning' : 'pill--success';
  }

  projectMeta(proj: Project): string {
    return [proj.sector, proj.status, proj.region].filter(Boolean).join(' · ');
  }

  async copyProjectId() {
    const proj = this.service.selectedProject();
    if (!proj) return;
    try {
      await navigator.clipboard.writeText(String(proj.id));
      this.copiedId.set(true);
      setTimeout(() => this.copiedId.set(false), 2000);
    } catch (err) {
      console.warn('[MapExplorer] Clipboard write refused:', err);
    }
  }

  private sizeObserver?: ResizeObserver;

  ngOnDestroy() {
    this.sizeObserver?.disconnect();
    this.destroyMap();
  }

  // GIS Leaflet Map initialization
  private initMap() {
    try {
      this.map = L.map('demi-map', { zoomControl: false, preferCanvas: true }).setView([54.0, -125.0], 5);
      // The pane is sized by flex after first paint; Leaflet keeps the size it measured at init.
      const host = document.getElementById('demi-map');
      if (host) {
        this.sizeObserver = new ResizeObserver(() => this.map?.invalidateSize());
        this.sizeObserver.observe(host);
      }
      
      // CARTO basemaps watermark every tile without an API key; OSM's own tiles are keyless.
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19
      }).addTo(this.map);

      L.control.zoom({ position: 'bottomright' }).addTo(this.map);

      const onMove = () => {
        this.updateViewportProjects();
      };
      this.map.on('moveend', onMove);
      this.map.on('zoomend', () => {
        onMove();
        this.updateBoundaryLayersStyles();
      });
      
      setTimeout(() => {
        this.updateViewportProjects();
      }, 500);

      this.syncMarkersToMap(this.service.filteredProjects() || []);
      // Do not load regional boundaries initially, respect activeBoundaryLayers
      const layers = this.service.activeBoundaryLayers();
      if (layers.includes('regions')) {
        this.loadRegionalBoundaries();
      }

    } catch (err) {
      console.error('Leaflet Map initialization failed:', err);
    }
  }

  private destroyMap() {
    try {
      if (this.map) {
        this.map.remove();
        this.map = null;
        this.regionsLayer = null;
        this.boundariesLayers.clear();
        this.markerClusterGroup = null;
        this.markersMap.clear();
      }
    } catch (err) {
      console.warn('Leaflet Map destruction skipped:', err);
    }
  }

  private viewportTimer: any = null;

  private updateViewportProjects() {
    if (!this.map) return;
    if (this.viewportTimer) clearTimeout(this.viewportTimer);

    this.viewportTimer = setTimeout(() => {
      if (!this.map) return;
      const bounds = this.map.getBounds();
      const inViewIds: (string | number)[] = [];

      (this.service.projects() || []).forEach(p => {
        if (p && p.centroid && Array.isArray(p.centroid) && p.centroid.length === 2) {
          const [lng, lat] = p.centroid;
          if (bounds.contains([lat, lng])) {
            inViewIds.push(p.id);
          }
        }
      });

      // Only update signal if list of visible IDs actually changed
      const prev = this.service.mapInViewProjectIds();
      if (prev.length !== inViewIds.length || !prev.every((id, i) => id === inViewIds[i])) {
        this.service.mapInViewProjectIds.set(inViewIds);
      }
    }, 150);
  }

  private canvasRenderer = L.canvas({ padding: 0.5, tolerance: 10 });

  private syncMarkersToMap(filteredProjects: Project[]) {
    if (!this.map) return;

    if (!this.markerClusterGroup) {
      this.markerClusterGroup = L.markerClusterGroup({
        showCoverageOnHover: false,
        maxClusterRadius: 40,
        spiderfyOnMaxZoom: true,
        chunkedLoading: true,
        chunkInterval: 50
      });
      this.map.addLayer(this.markerClusterGroup);
    }

    const nextIds = new Set(filteredProjects.map(p => p.id));
    const toRemove: (string | number)[] = [];

    // Remove markers for projects no longer in active filter
    this.markersMap.forEach((marker, id) => {
      if (!nextIds.has(id)) {
        this.markerClusterGroup.removeLayer(marker);
        toRemove.push(id);
      }
    });
    toRemove.forEach(id => this.markersMap.delete(id));

    // Reuse existing markers and only create new markers for newly matched projects
    filteredProjects.forEach(p => {
      if (!p || !p.centroid || !Array.isArray(p.centroid) || p.centroid.length !== 2) return;

      if (!this.markersMap.has(p.id)) {
        const [lng, lat] = p.centroid;

        const customIcon = L.divIcon({
          className: p.gatingState === 'staged' ? 'demi-marker demi-marker--staged' : 'demi-marker',
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        });

        const marker = L.marker([lat, lng], { icon: customIcon });

        marker.bindPopup(`
          <div class="popup-title">${p.name}</div>
          <div class="popup-meta"><strong>Sector:</strong> ${p.sector ?? ''}</div>
          <div class="popup-meta"><strong>Status:</strong> ${p.status ?? ''}</div>
        `);

        marker.on('click', () => {
          this.selectProject(p);
        });

        this.markerClusterGroup.addLayer(marker);
        this.markersMap.set(p.id, marker);
      }
    });
  }

  private loadRegionalBoundaries() {
    const geojson = this.service.regionalBoundariesGeoJSON();
    if (!geojson || !this.map) return;

    if (this.regionsLayer) {
      try {
        this.regionsLayer.clearLayers();
        this.map.removeLayer(this.regionsLayer);
      } catch (err) {
        console.warn('Error removing old regions layer:', err);
      }
      this.regionsLayer = null;
    }

    this.regionsLayer = L.geoJSON(geojson, {
      renderer: this.canvasRenderer,
      style: (feature: any) => this.getRegionStyle(feature?.properties?.regionName),
      onEachFeature: (feature: any, layer: any) => {
        const name = feature?.properties?.regionName;
        this.bindUnifiedTooltip(layer, name, 'regions');

        layer.on({
          mouseover: (e: any) => {
            const ly = e.target;
            const selected = this.service.regionFilter();
            if (!selected.size || this.isRegionSelected(name)) {
              ly.setStyle({
                weight: 3.0,
                color: '#fcba19',
                fillColor: '#fcba19',
                fillOpacity: 0.22,
                dashArray: ''
              });
            } else {
              ly.setStyle({
                weight: 2.0,
                color: '#fcba19',
                fillColor: '#fcba19',
                fillOpacity: 0.12,
                opacity: 0.6,
                dashArray: '3, 3'
              });
            }
          },
          mouseout: (e: any) => {
            const ly = e.target;
            if (this.regionsLayer) {
              this.regionsLayer.resetStyle(ly);
            }
            ly.setStyle(this.getRegionStyle(name));
          },
          click: (_e: any) => this.setRegionFilter(name)
        });
      }
    } as L.GeoJSONOptions).addTo(this.map);

    if (this.regionsLayer) {
      this.regionsLayer.bringToBack();
    }
  }

  /** Case-insensitive: the map's own region names and the filter list are separate sources. */
  private isRegionSelected(regionName: string): boolean {
    const wanted = (regionName || '').toLowerCase();
    return [...this.service.regionFilter()].some(r => r.toLowerCase() === wanted);
  }

  private getRegionStyle(regionName: string): any {
    const isSelected = this.isRegionSelected(regionName);
    const hasAnySelection = this.service.regionFilter().size > 0;

    if (isSelected) {
      return {
        weight: 4.5,
        color: '#fcba19',
        opacity: 1.0,
        fillColor: '#fcba19',
        fillOpacity: 0.14,
        dashArray: ''
      };
    }

    if (hasAnySelection) {
      return {
        weight: 1.0,
        color: '#fcba19',
        fillColor: '#fcba19',
        fillOpacity: 0.01,
        opacity: 0.4,
        dashArray: '3, 3'
      };
    }

    return {
      weight: 1.5,
      color: '#fcba19',
      fillColor: '#fcba19',
      fillOpacity: 0.06,
      dashArray: ''
    };
  }

  private updateRegionsLayerStyle() {
    if (this.regionsLayer) {
      this.regionsLayer.eachLayer((layer: any) => {
        const name = layer.feature?.properties?.regionName;
        layer.setStyle(this.getRegionStyle(name));
      });
    }
  }

  setRegionFilter(region: string) {
    this.service.toggleFilterValue(this.service.regionFilter, region);
    this.updateRegionsLayerStyle();
  }

  // UI Event Handlers
  onSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.service.searchQuery.set(value);

    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.service.loadData();
    }, 300);
  }

  private searchDebounceTimer: any = null;

  setActiveTab(tab: 'projects' | 'documents') {
    this.service.activeTab.set(tab);
    this.service.resetSelection();
  }

  selectProject(proj: Project) {
    this.service.selectProject(proj);

    if (this.map && proj.centroid) {
      const [lng, lat] = proj.centroid;
      this.map.setView([lat, lng], 8, { animate: true });

      const marker = this.markersMap.get(proj.id);
      if (marker) {
        marker.openPopup();
      }
    }
  }

  /** Hand the project's name to Index Search, which is where documents are listed. */
  viewProjectDocuments(proj: Project) {
    this.setActiveTab('documents');
    this.service.searchQuery.set(proj.name);
    this.service.loadData();
    this.router.navigate(['/index']);
  }

  getProjDocCount(projId: string | number): number {
    return (this.service.documents() || []).filter(d => d.projectId === projId).length;
  }

  private renderBoundaryShapes(boundaries: any[], type: string) {
    if (!this.map) return;

    // Clean up existing layer group for this type first
    const existing = this.boundariesLayers.get(type);
    if (existing) {
      try {
        existing.clearLayers();
        this.map.removeLayer(existing);
      } catch (err) {
        console.warn(`Error removing old boundaries layer for ${type}:`, err);
      }
      this.boundariesLayers.delete(type);
    }

    // Convert array of database boundary objects into a standard GeoJSON FeatureCollection
    const featureCollection = {
      type: 'FeatureCollection',
      features: boundaries.map(b => ({
        type: 'Feature',
        properties: {
          id: b._id,
          name: b.name,
          type: b.type,
          code: b.code
        },
        geometry: b.geometry || b.simplifiedGeometry
      }))
    };

    const newLayer = L.geoJSON(featureCollection as GeoJSON.FeatureCollection, {
      renderer: this.canvasRenderer,
      smoothFactor: 1.0, // Auto-simplifies geometry at lower zoom levels for premium performance
      style: (feature: any) => {
        const name = feature?.properties?.name;
        const selected = this.boundarySelection(type);
        const isSelected = selected.has(name);
        const hasAnySelection = selected.size > 0;

        let strokeColor = '#0d9488';
        let fOpacity = 0.06;

        if (type === 'regionalDistricts') {
          strokeColor = '#6366f1';
          fOpacity = 0.07;
        } else if (type === 'municipalities') {
          strokeColor = '#0d9488';
          fOpacity = 0.06;
        } else if (type === 'electoralDistricts') {
          strokeColor = '#ec4899';
          fOpacity = 0.07;
        }

        if (isSelected) {
          return {
            weight: 3.5,
            color: strokeColor,
            fillColor: strokeColor,
            fillOpacity: fOpacity + 0.15,
            dashArray: ''
          };
        }

        if (hasAnySelection) {
          return {
            weight: 1.0,
            color: strokeColor,
            fillColor: strokeColor,
            fillOpacity: fOpacity / 2,
            opacity: 0.4,
            dashArray: '3, 3'
          };
        }

        return {
          weight: 1.5,
          color: strokeColor,
          fillColor: strokeColor,
          fillOpacity: fOpacity,
          dashArray: ''
        };
      },
      onEachFeature: (feature: any, layer: any) => {
        const name = feature?.properties?.name;
        
        // Beautiful sticky high-contrast tooltip - identical to environmental regions
        this.bindUnifiedTooltip(layer, name, type);
 
        layer.on({
          mouseover: (e: any) => {
            const ly = e.target;
            const selected = this.boundarySelection(type);
            const isSelected = selected.has(name);
            const hasAnySelection = selected.size > 0;

            let highlightColor = '#6366f1';
            let hoverFillOpacity = 0.20;

            if (type === 'regionalDistricts') {
              highlightColor = '#6366f1';
              hoverFillOpacity = 0.20;
            } else if (type === 'municipalities') {
              highlightColor = '#0d9488';
              hoverFillOpacity = 0.18;
            } else if (type === 'electoralDistricts') {
              highlightColor = '#ec4899';
              hoverFillOpacity = 0.20;
            }

            if (!hasAnySelection || isSelected) {
              ly.setStyle({
                weight: 3.0,
                color: highlightColor,
                fillColor: highlightColor,
                fillOpacity: hoverFillOpacity,
                dashArray: ''
              });
            } else {
              ly.setStyle({
                weight: 2.0,
                color: highlightColor,
                fillColor: highlightColor,
                fillOpacity: hoverFillOpacity / 2,
                opacity: 0.6,
                dashArray: '3, 3'
              });
            }
          },
          mouseout: (e: any) => {
            const ly = e.target;
            const targetLayer = this.boundariesLayers.get(type);
            if (targetLayer) {
              targetLayer.resetStyle(ly);
            }
          },
          click: (_e: any) => {
            this.setBoundaryFilter(type, name);
            if (this.boundarySelection(type).has(name) && layer.getBounds) {
              const bounds = layer.getBounds();
              if (bounds && bounds.isValid()) {
                this.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 10, animate: true, duration: 0.4 });
              }
            }
          }
        });
      }
    } as L.GeoJSONOptions).addTo(this.map);

    this.boundariesLayers.set(type, newLayer);
    newLayer.bringToBack();
  }

  private updateBoundaryLayersStyles() {
    this.boundariesLayers.forEach((layerGroup) => {
      layerGroup.eachLayer((layer: any) => {
        layerGroup.resetStyle(layer);
      });
    });
  }

  private bindUnifiedTooltip(layer: any, name: string, _type: string) {
    layer.bindTooltip(`<strong>${(name || '').trim()}</strong>`, {
      sticky: true,
      className: 'region-tooltip'
    });
  }



  setBoundaryFilter(layer: string, name: string) {
    this.service.toggleBoundaryFilter(layer, name);
    // Ticking a boundary whose overlay is off would filter the results against something the map
    // is not drawing, so turn the overlay on with it.
    const active = this.service.activeBoundaryLayers();
    if (!active.includes(layer)) this.service.activeBoundaryLayers.set([...active, layer]);
    this.updateBoundaryLayersStyles();
  }

  highlightText(text: string | undefined, query: string): string {
    return this.service.highlightText(text, query);
  }

  isLayerActive(layer: string): boolean {
    return this.service.activeBoundaryLayers().includes(layer);
  }

  toggleLayer(layer: string) {
    const current = this.service.activeBoundaryLayers();
    if (current.includes(layer)) {
      this.service.activeBoundaryLayers.set(current.filter(l => l !== layer));
      // Only this layer's selections go: the other layers filter on independently.
      const selected = this.service.boundaryFilter();
      if (selected[layer]?.size) this.service.boundaryFilter.set({ ...selected, [layer]: new Set() });
    } else {
      this.service.activeBoundaryLayers.set([...current, layer]);
    }
  }

  toggleWildfires() {
    this.showWildfires.set(!this.showWildfires());
  }

  private loadWildfiresOnMap() {
    if (!this.map) return;
    if (this.wildfireLayerGroup) {
      this.map.removeLayer(this.wildfireLayerGroup);
      this.wildfireLayerGroup = null;
    }

    const fireCentres: Record<number, string> = {
      1: 'Cariboo Fire Centre',
      2: 'Kamloops Fire Centre',
      3: 'Coastal Fire Centre',
      4: 'Prince George Fire Centre',
      5: 'Northwest Fire Centre',
      6: 'Southeast Fire Centre'
    };

    const wfsUrl = 'https://openmaps.gov.bc.ca/geo/pub/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=pub:WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_PNTS_SP&outputFormat=application/json&srsName=EPSG:4326';

    fetch(wfsUrl)
      .then(res => res.json())
      .then(geoJson => {
        if (!geoJson || !geoJson.features) return;

        this.wildfireLayerGroup = L.geoJSON(geoJson, {
          pointToLayer: (feature: any, latlng: any) => {
            const props = feature.properties || {};
            const status = props.FIRE_STATUS || 'Active';
            const isFireOfNote = props.FIRE_OF_NOTE_IND === 'Y' || status === 'Fire of Note';

            let color = '#d90429'; // Red for Out of Control / Fire of Note
            if (status === 'Out') {
              color = '#6c757d'; // Gray for extinguised
            } else if (status === 'Under Control') {
              color = '#2b9348'; // Muted Green for under control
            } else if (status === 'Being Held') {
              color = '#e85d04'; // Orange for being held
            }

            // Ensure valid lat/lng coordinates
            let validLatLng = latlng;
            if ((!latlng || Math.abs(latlng.lat) > 90 || Math.abs(latlng.lng) > 180) && props.LATITUDE && props.LONGITUDE) {
              validLatLng = L.latLng(props.LATITUDE, props.LONGITUDE);
            }

            const sizePx = isFireOfNote ? 30 : (status === 'Out' ? 20 : 26);
            const anchorPx = Math.floor(sizePx / 2);

            const customIcon = L.divIcon({
              className: 'wildfire-marker-icon',
              html: `<div class="wildfire-marker-pill ${isFireOfNote ? 'fire-of-note' : ''}" style="background-color: ${color}; width: ${sizePx}px; height: ${sizePx}px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/></svg></div>`,
              iconSize: [sizePx, sizePx],
              iconAnchor: [anchorPx, anchorPx]
            });

            return L.marker(validLatLng, { icon: customIcon });
          },
          onEachFeature: (feature: any, layer: any) => {
            const props = feature.properties || {};
            const fireNum = props.FIRE_NUMBER || 'Wildfire';
            const incidentName = props.INCIDENT_NAME && props.INCIDENT_NAME !== fireNum ? props.INCIDENT_NAME : '';
            const title = incidentName ? `${incidentName} (${fireNum})` : fireNum;
            const status = props.FIRE_STATUS || 'Active';
            const cause = props.FIRE_CAUSE || 'Unknown';
            const size = props.CURRENT_SIZE != null ? `${props.CURRENT_SIZE} ha` : 'Unknown';
            const centerName = fireCentres[props.FIRE_CENTRE] || `Fire Centre #${props.FIRE_CENTRE || 'Unknown'}`;
            const location = props.GEOGRAPHIC_DESCRIPTION || '';
            const ignition = props.IGNITION_DATE ? props.IGNITION_DATE.replace('Z', '') : '';
            const isNote = props.FIRE_OF_NOTE_IND === 'Y';

            const popupContent = `
              <div style="font-family: sans-serif; padding: 4px; max-width: 250px;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 6px;">
                  <h4 style="margin: 0; color: #d90429; font-size: 0.95rem;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/></svg> ${title}
                  </h4>
                  ${isNote ? '<span style="background: #d90429; color: white; font-size: 0.65rem; font-weight: 700; padding: 2px 6px; border-radius: 4px;">FIRE OF NOTE</span>' : ''}
                </div>
                <p style="margin: 3px 0; font-size: 0.8rem;"><strong>Status:</strong> <span style="font-weight: 700;">${status}</span></p>
                ${location ? `<p style="margin: 3px 0; font-size: 0.8rem;"><strong>Location:</strong> ${location.trim()}</p>` : ''}
                <p style="margin: 3px 0; font-size: 0.8rem;"><strong>Current Size:</strong> ${size}</p>
                <p style="margin: 3px 0; font-size: 0.8rem;"><strong>Cause:</strong> ${cause}</p>
                <p style="margin: 3px 0; font-size: 0.8rem;"><strong>Fire Center:</strong> ${centerName}</p>
                ${ignition ? `<p style="margin: 3px 0; font-size: 0.8rem;"><strong>Ignited:</strong> ${ignition}</p>` : ''}
                ${props.FIRE_URL ? `
                  <div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid #eee;">
                    <a href="${props.FIRE_URL}" target="_blank" rel="noopener" style="color: #0056b3; font-size: 0.78rem; font-weight: 600; text-decoration: underline; display: inline-flex; align-items: center; gap: 4px;">
                      View Official BC Wildfire Details <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>
                    </a>
                  </div>
                ` : ''}
              </div>
            `;

            layer.bindPopup(popupContent);
          }
        }).addTo(this.map);
      })
      .catch(err => {
        console.warn('Failed to load active wildfires from DataBC WFS:', err);
      });
  }
}
