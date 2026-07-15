import { Component, OnInit, OnDestroy, AfterViewInit, inject, effect, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RegistryStateService } from '../../services/registry-state.service';
import { Project, Document } from '../../models/registry.models';

declare const L: any;

@Component({
  selector: 'app-map-explorer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './map-explorer.component.html',
  styleUrls: []
})
export class MapExplorerComponent implements OnInit, OnDestroy, AfterViewInit {
  service = inject(RegistryStateService);

  availableRegions = ['Vancouver Island', 'Lower Mainland', 'Thompson', 'Kootenay', 'Cariboo', 'Skeena', 'Omineca', 'Okanagan', 'Peace'];

  public map: any = null;
  private regionsLayer: any = null;
  private boundariesLayer: any = null;
  private markerClusterGroup: any = null;
  private markersMap = new Map<any, any>();

  // Custom searchable select signals
  boundarySearchQuery = signal<string>('');
  showBoundaryDropdown = signal<boolean>(false);

  filteredBoundaryNames = computed(() => {
    const q = this.boundarySearchQuery().toLowerCase().trim();
    const names = this.service.activeBoundaryNames();
    if (!q) return names;
    return names.filter(name => name.toLowerCase().includes(q));
  });

  constructor() {
    // Sync boundaryFilter with boundarySearchQuery for the custom searchable list
    effect(() => {
      const activeFilter = this.service.boundaryFilter();
      if (activeFilter === 'all' || activeFilter === '') {
        this.boundarySearchQuery.set('');
      } else {
        this.boundarySearchQuery.set(activeFilter);
      }
    });

    // Re-sync map markers whenever our filtered projects or role change!
    effect(() => {
      const filtered = this.service.filteredProjects() || [];
      this.syncMarkersToMap(filtered);
      setTimeout(() => this.updateViewportProjects(), 100);
    });

    // Re-render regional boundaries whenever they are loaded or map is ready!
    effect(() => {
      const bLayer = this.service.activeBoundaryLayer();
      const geojson = this.service.regionalBoundariesGeoJSON();
      if (geojson && this.map && bLayer === 'regions') {
        this.loadRegionalBoundaries();
      }
    });

    // Re-render administrative boundaries whenever they change or are loaded!
    effect(async () => {
      const bLayer = this.service.activeBoundaryLayer();
      const bFilter = this.service.boundaryFilter();
      
      if (!this.map) return;

      // Clean up previous boundariesLayer
      if (this.boundariesLayer) {
        try {
          this.map.removeLayer(this.boundariesLayer);
        } catch (err) {
          console.warn('Error removing old boundaries layer:', err);
        }
        this.boundariesLayer = null;
      }

      // Mutual exclusion: if activeBoundaryLayer is regions, show environmental regions, otherwise hide them!
      if (bLayer === 'regions') {
        this.loadRegionalBoundaries();
      } else {
        // Hide regional boundaries
        if (this.regionsLayer) {
          try {
            this.map.removeLayer(this.regionsLayer);
          } catch (err) {
            console.warn('Error removing old regions layer:', err);
          }
          this.regionsLayer = null;
        }
      }

      if (bLayer === 'none' || bLayer === 'regions') {
        return;
      }

      // Load boundary metadata from cache/API (without geometries)
      await this.service.loadBoundaryGeometry(bLayer);

      // Only render if a specific single boundary item is specified/selected!
      if (bFilter !== 'all') {
        const singleBoundaryData = await this.service.loadSingleBoundaryGeometry(bLayer, bFilter);
        if (singleBoundaryData && this.map && this.service.activeBoundaryLayer() === bLayer && this.service.boundaryFilter() === bFilter) {
          this.renderBoundaryShapes([singleBoundaryData], bLayer, bFilter);

          // Auto-center map and fit bounds to the single selected boundary shape
          if (this.boundariesLayer) {
            this.boundariesLayer.eachLayer((layer: any) => {
              if (layer.getBounds) {
                const bounds = layer.getBounds();
                if (bounds && bounds.isValid()) {
                  this.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 10, animate: true, duration: 0.4 });
                }
              }
            });
          }
        }
      }
    });
  }

  ngOnInit() {
    this.service.activePage.set('map');
  }

  ngAfterViewInit() {
    setTimeout(() => {
      this.initMap();
    }, 50);
  }

  ngOnDestroy() {
    this.destroyMap();
  }

  // GIS Leaflet Map initialization
  private initMap() {
    try {
      this.map = L.map('map', { zoomControl: false }).setView([54.0, -125.0], 5);
      
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
      }).addTo(this.map);

      L.control.zoom({ position: 'bottomright' }).addTo(this.map);

      const onMove = () => this.updateViewportProjects();
      this.map.on('moveend', onMove);
      this.map.on('zoomend', () => {
        onMove();
        const bLayer = this.service.activeBoundaryLayer();
        if (bLayer === 'municipalities' && this.boundariesLayer) {
          const bFilter = this.service.boundaryFilter();
          if (bFilter !== 'all') {
            const currentCache = this.service.loadedBoundariesGeoJSON();
            const data = currentCache[bLayer];
            if (data && Array.isArray(data)) {
              const match = data.find((b: any) => (b.name || '').toLowerCase() === bFilter.toLowerCase());
              if (match && match.geometry) {
                this.renderBoundaryShapes([match], bLayer, bFilter);
              }
            }
          }
        }
      });
      
      setTimeout(() => this.updateViewportProjects(), 500);

      this.syncMarkersToMap(this.service.filteredProjects() || []);
      // Do not load regional boundaries initially, respect activeBoundaryLayer
      const bLayer = this.service.activeBoundaryLayer();
      if (bLayer === 'regions') {
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
        this.boundariesLayer = null;
        this.markerClusterGroup = null;
        this.markersMap.clear();
      }
    } catch (err) {
      console.warn('Leaflet Map destruction skipped:', err);
    }
  }

  private updateViewportProjects() {
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

    this.service.mapInViewProjectIds.set(inViewIds);
  }

  private syncMarkersToMap(filteredProjects: Project[]) {
    if (!this.map) return;

    if (!this.markerClusterGroup) {
      this.markerClusterGroup = L.markerClusterGroup({
        showCoverageOnHover: false,
        maxClusterRadius: 40,
        spiderfyOnMaxZoom: true
      });
      this.map.addLayer(this.markerClusterGroup);
    }

    this.markerClusterGroup.clearLayers();
    this.markersMap.clear();

    filteredProjects.forEach(p => {
      if (p && p.centroid && Array.isArray(p.centroid) && p.centroid.length === 2) {
        const [lng, lat] = p.centroid;

        const customIcon = L.divIcon({
          className: p.gatingState === 'staged' ? 'custom-marker staged' : 'custom-marker',
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        });

        const marker = L.marker([lat, lng], { icon: customIcon });

        marker.bindPopup(`
          <div class="popup-title">${p.name}</div>
          <div class="popup-meta"><strong>Sector:</strong> ${p.sector}</div>
          <div class="popup-meta"><strong>Status:</strong> ${p.status}</div>
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
        this.map.removeLayer(this.regionsLayer);
      } catch (err) {
        console.warn('Error removing old regions layer:', err);
      }
      this.regionsLayer = null;
    }

    this.regionsLayer = L.geoJSON(geojson, {
      style: (feature: any) => this.getRegionStyle(feature?.properties?.regionName),
      onEachFeature: (feature: any, layer: any) => {
        const name = feature?.properties?.regionName;
        this.bindUnifiedTooltip(layer, name, 'regions');

        layer.on({
          mouseover: (e: any) => {
            const ly = e.target;
            const currentFilter = this.service.regionFilter();
            if (currentFilter === 'all' || currentFilter.toLowerCase() === name.toLowerCase()) {
              ly.setStyle({
                weight: 3,
                color: '#fcba19',
                fillColor: '#fcba19',
                fillOpacity: 0.22
              });
            } else {
              ly.setStyle({
                weight: 2,
                color: '#fcba19',
                fillOpacity: 0.12
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
          click: (e: any) => {
            const current = this.service.regionFilter();
            if (current.toLowerCase() === name.toLowerCase()) {
              this.setRegionFilter('all');
            } else {
              this.setRegionFilter(name);
            }
          }
        });
      }
    }).addTo(this.map);

    if (this.regionsLayer) {
      this.regionsLayer.bringToBack();
    }
  }

  private getRegionStyle(regionName: string): any {
    const selected = this.service.regionFilter();
    const isSelected = selected !== 'all' && selected.toLowerCase() === (regionName || '').toLowerCase();
    const hasAnySelection = selected !== 'all';

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
        color: '#38598a',
        fillColor: '#38598a',
        fillOpacity: 0.01,
        dashArray: '3'
      };
    }

    return {
      weight: 1.5,
      color: '#38598a',
      fillColor: '#38598a',
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
    this.service.setRegionFilter(region);
    this.updateRegionsLayerStyle();
  }

  // UI Event Handlers
  onSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.service.searchQuery.set(value);

    // shortcut: set loading placeholder sentinel values immediately
    this.service.projects.set(null);
    if (value) {
      this.service.documents.set(null);
    } else {
      this.service.documents.set([]);
    }

    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.service.loadData();
    }, 300);
  }

  private searchDebounceTimer: any = null;

  setGatingFilter(state: 'all' | 'admitted' | 'staged') {
    this.service.setGatingFilter(state);
  }

  setSectorFilter(sector: string) {
    this.service.setSectorFilter(sector);
  }

  setActiveTab(tab: 'projects' | 'documents') {
    this.service.activeTab.set(tab);
    this.service.resetSelection();
  }

  selectProject(proj: Project) {
    this.service.selectProject(proj);

    if (this.map) {
      const [lng, lat] = proj.centroid;
      this.map.setView([lat, lng], 8, { animate: true });

      const marker = this.markersMap.get(proj.id);
      if (marker) {
        marker.openPopup();
      }
    }
  }

  selectDocument(doc: Document) {
    this.service.selectDocument(doc);
  }

  viewProjectDocuments(proj: Project) {
    this.setActiveTab('documents');
    this.service.searchQuery.set(proj.name);
    this.service.loadData();
  }

  getProjDocCount(projId: string | number): number {
    return (this.service.documents() || []).filter(d => d.projectId === projId).length;
  }

  getFullJson(proj: Project): string {
    if (!proj || !proj.rawMetadata) return '{}';
    return JSON.stringify(proj.rawMetadata, null, 2);
  }

  private renderBoundaryShapes(boundaries: any[], type: string, filterValue: string) {
    if (!this.map) return;

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
        geometry: b.geometry
      }))
    };

    const currentZoom = this.map.getZoom();

    this.boundariesLayer = L.geoJSON(featureCollection, {
      smoothFactor: 1.0, // Auto-simplifies geometry at lower zoom levels for premium performance
      style: (feature: any) => {
        const name = feature?.properties?.name;
        const isSelected = filterValue !== 'all' && filterValue.toLowerCase() === (name || '').toLowerCase();
        const hasAnySelection = filterValue !== 'all';

        // Zoom gating: Municipalities only visible at Zoom > 6
        if (type === 'municipalities' && currentZoom <= 6) {
          return {
            weight: 0,
            fillOpacity: 0,
            opacity: 0,
            interactive: false
          };
        }

        if (isSelected) {
          return {
            weight: 4.5,
            color: '#6366f1',
            opacity: 1.0,
            fillColor: '#6366f1',
            fillOpacity: 0.12,
            dashArray: ''
          };
        }

        if (hasAnySelection) {
          return {
            weight: 1.0,
            color: '#0d9488',
            fillColor: '#0d9488',
            fillOpacity: 0.01,
            dashArray: '3, 3'
          };
        }

        return {
          weight: 1.5,
          color: '#0d9488',
          fillColor: '#0d9488',
          fillOpacity: 0.04,
          dashArray: ''
        };
      },
      onEachFeature: (feature: any, layer: any) => {
        const name = feature?.properties?.name;
        
        // Zoom-gated interactive boundaries
        if (type === 'municipalities' && currentZoom <= 6) {
          return;
        }
 
        // Dynamic matches calculation
        const matchCount = this.getMatchingProjectsCountForBoundary(name, type);
 
        // Beautiful sticky high-contrast tooltip - identical to environmental regions
        this.bindUnifiedTooltip(layer, name, type);
 
        layer.on({
          mouseover: (e: any) => {
            const ly = e.target;
            const isSelected = filterValue !== 'all' && filterValue.toLowerCase() === (name || '').toLowerCase();
            
            if (isSelected) {
              ly.setStyle({
                weight: 5.5,
                color: '#6366f1',
                fillColor: '#6366f1',
                fillOpacity: 0.22
              });
            } else {
              ly.setStyle({
                weight: 3.0,
                color: '#6366f1',
                fillColor: '#6366f1',
                fillOpacity: 0.18
              });
            }
          },
          mouseout: (e: any) => {
            const ly = e.target;
            if (this.boundariesLayer) {
              this.boundariesLayer.resetStyle(ly);
            }
          },
          click: (e: any) => {
            const current = this.service.boundaryFilter();
            if (current.toLowerCase() === name.toLowerCase()) {
              this.setBoundaryFilter('all');
            } else {
              this.setBoundaryFilter(name);
              if (layer.getBounds) {
                const bounds = layer.getBounds();
                if (bounds && bounds.isValid()) {
                  this.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 10, animate: true, duration: 0.4 });
                }
              }
            }
          }
        });
      }
    }).addTo(this.map);

    if (this.boundariesLayer) {
      this.boundariesLayer.bringToBack();
    }
  }

  private bindUnifiedTooltip(layer: any, name: string, type: string) {
    let suffix = '';
    if (type === 'regions') suffix = 'Region';
    else if (type === 'regionalDistricts') suffix = 'Regional District';
    else if (type === 'municipalities') suffix = 'Municipality';
    else if (type === 'electoralDistricts') suffix = 'Electoral District';

    layer.bindTooltip(`<strong>${name}${suffix ? ' ' + suffix : ''}</strong>`, {
      sticky: true,
      className: 'region-tooltip'
    });
  }

  private getMatchingProjectsCountForBoundary(name: string, type: string): number {
    const allProjs = this.service.projects() || [];
    
    const activeSector = this.service.sectorFilter();
    const activeGating = this.service.gatingFilter();
    const activeQuery = this.service.searchQuery().toLowerCase();
    
    return allProjs.filter(p => {
      // Role access gating
      if (this.service.currentRole() === 'public' && p.gatingState !== 'admitted') return false;

      // Sector check
      if (activeSector !== 'all') {
        const pSector = (p.sector || '').toLowerCase();
        const fSector = activeSector.toLowerCase();
        if (fSector === 'mining') {
          if (!pSector.startsWith('mine') && !pSector.includes('mining')) return false;
        } else {
          if (!pSector.includes(fSector)) return false;
        }
      }

      // Gating check
      if (activeGating !== 'all' && p.gatingState !== activeGating) return false;

      // Query check
      if (activeQuery) {
        const serialized = JSON.stringify(p);
        if (!this.service.fuzzyMatch(serialized, activeQuery)) return false;
      }

      // Boundary check using high-performance dynamic client-side containment checks
      return this.service.isProjectInBoundary(p, type, name);
    }).length;
  }

  setBoundaryFilter(val: string) {
    this.service.boundaryFilter.set(val);
    if (this.boundariesLayer) {
      this.boundariesLayer.eachLayer((layer: any) => {
        if (this.boundariesLayer) {
          this.boundariesLayer.resetStyle(layer);
        }
      });
    }
  }

  onBoundarySearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.boundarySearchQuery.set(value);
    if (!value.trim()) {
      this.service.boundaryFilter.set('');
    }
  }

  selectBoundaryOption(name: string) {
    this.setBoundaryFilter(name);
    this.showBoundaryDropdown.set(false);
  }

  onBoundaryDropdownBlur() {
    setTimeout(() => {
      this.showBoundaryDropdown.set(false);
      const activeFilter = this.service.boundaryFilter();
      if (activeFilter === 'all' || activeFilter === '') {
        this.boundarySearchQuery.set('');
      } else {
        this.boundarySearchQuery.set(activeFilter);
      }
    }, 200);
  }

  highlightText(text: string, query: string): string {
    return this.service.highlightText(text, query);
  }
}
