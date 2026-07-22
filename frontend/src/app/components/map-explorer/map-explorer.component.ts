import { Component, OnInit, OnDestroy, AfterViewInit, inject, effect, signal, computed, untracked } from '@angular/core';
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
  private boundariesLayers = new Map<string, any>();
  private markerClusterGroup: any = null;
  private markersMap = new Map<any, any>();

  // Custom searchable select signals per category
  activeDistrictQuery = signal<string>('');
  showDistrictDropdown = signal<boolean>(false);

  activeMuniQuery = signal<string>('');
  showMuniDropdown = signal<boolean>(false);

  activeElectoralQuery = signal<string>('');
  showElectoralDropdown = signal<boolean>(false);

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

  constructor() {
    // Sync boundaryFilters with active search queries
    effect(() => {
      const activeFilter = this.service.boundaryFilter();
      const activeLayer = this.service.boundaryFilterLayer();
      
      if (activeFilter === 'all' || activeFilter === '') {
        this.activeDistrictQuery.set('');
        this.activeMuniQuery.set('');
        this.activeElectoralQuery.set('');
      } else {
        if (activeLayer === 'regionalDistricts') {
          this.activeDistrictQuery.set(activeFilter);
        } else if (activeLayer === 'municipalities') {
          this.activeMuniQuery.set(activeFilter);
        } else if (activeLayer === 'electoralDistricts') {
          this.activeElectoralQuery.set(activeFilter);
        }
      }
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
        if (regionsGeojson && !this.regionsLayer) {
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
      this.service.boundaryFilterLayer();
      untracked(() => {
        this.updateBoundaryLayersStyles();
      });
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

  ngOnDestroy() {
    this.destroyMap();
  }

  // GIS Leaflet Map initialization
  private initMap() {
    try {
      this.map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([54.0, -125.0], 5);
      
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
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
          click: (_e: any) => {
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

  private renderBoundaryShapes(boundaries: any[], type: string) {
    if (!this.map) return;

    // Clean up existing layer group for this type first
    const existing = this.boundariesLayers.get(type);
    if (existing) {
      try {
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

    const newLayer = L.geoJSON(featureCollection, {
      smoothFactor: 1.0, // Auto-simplifies geometry at lower zoom levels for premium performance
      style: (feature: any) => {
        const currentZoom = this.map ? this.map.getZoom() : 13;
        // Zoom gating: Municipalities only visible at Zoom > 6
        if (type === 'municipalities' && currentZoom <= 6) {
          return {
            weight: 0,
            fillOpacity: 0,
            opacity: 0,
            interactive: false
          };
        }

        const name = feature?.properties?.name;
        const filterValue = this.service.boundaryFilter() || 'all';
        const filterLayer = this.service.boundaryFilterLayer() || 'none';
        const isSelected = filterValue !== 'all' && filterValue !== '' && filterLayer === type && (name || '').toLowerCase() === filterValue.toLowerCase();
        const hasAnySelection = filterValue !== 'all' && filterValue !== '';

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
            const filterValue = this.service.boundaryFilter() || 'all';
            const filterLayer = this.service.boundaryFilterLayer() || 'none';
            const isSelected = filterValue !== 'all' && filterValue !== '' && filterLayer === type && (name || '').toLowerCase() === filterValue.toLowerCase();
            const hasAnySelection = filterValue !== 'all' && filterValue !== '';

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
            const currentFilter = this.service.boundaryFilter();
            if (currentFilter.toLowerCase() === (name || '').toLowerCase()) {
              this.service.boundaryFilter.set('all');
              this.service.boundaryFilterLayer.set('none');
            } else {
              this.service.boundaryFilter.set(name);
              this.service.boundaryFilterLayer.set(type);
              if (layer.getBounds) {
                const bounds = layer.getBounds();
                if (bounds && bounds.isValid()) {
                  this.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 10, animate: true, duration: 0.4 });
                }
              }
            }
            this.updateBoundaryLayersStyles();
          }
        });
      }
    }).addTo(this.map);

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



  setBoundaryFilter(val: string, layerType: string) {
    this.service.boundaryFilter.set(val);
    if (val === 'all' || val === '') {
      this.service.boundaryFilterLayer.set('none');
    } else {
      this.service.boundaryFilterLayer.set(layerType);
      
      // Automatically enable respective map overlay category on the map
      const currentLayers = this.service.activeBoundaryLayers();
      if (!currentLayers.includes(layerType)) {
        this.service.activeBoundaryLayers.set([...currentLayers, layerType]);
      }
    }
    this.boundariesLayers.forEach((targetLayer) => {
      targetLayer.eachLayer((layer: any) => {
        targetLayer.resetStyle(layer);
      });
    });
  }

  onDistrictSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.activeDistrictQuery.set(value);
    if (!value.trim()) {
      this.setBoundaryFilter('all', 'none');
    }
  }

  selectDistrictOption(name: string) {
    this.setBoundaryFilter(name, 'regionalDistricts');
    this.showDistrictDropdown.set(false);
  }

  onDistrictDropdownBlur() {
    setTimeout(() => {
      this.showDistrictDropdown.set(false);
      const activeFilter = this.service.boundaryFilter();
      const activeLayer = this.service.boundaryFilterLayer();
      if (activeLayer === 'regionalDistricts') {
        this.activeDistrictQuery.set(activeFilter);
      } else {
        this.activeDistrictQuery.set('');
      }
    }, 200);
  }

  onMuniSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.activeMuniQuery.set(value);
    if (!value.trim()) {
      this.setBoundaryFilter('all', 'none');
    }
  }

  selectMuniOption(name: string) {
    this.setBoundaryFilter(name, 'municipalities');
    this.showMuniDropdown.set(false);
  }

  onMuniDropdownBlur() {
    setTimeout(() => {
      this.showMuniDropdown.set(false);
      const activeFilter = this.service.boundaryFilter();
      const activeLayer = this.service.boundaryFilterLayer();
      if (activeLayer === 'municipalities') {
        this.activeMuniQuery.set(activeFilter);
      } else {
        this.activeMuniQuery.set('');
      }
    }, 200);
  }

  onElectoralSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.activeElectoralQuery.set(value);
    if (!value.trim()) {
      this.setBoundaryFilter('all', 'none');
    }
  }

  selectElectoralOption(name: string) {
    this.setBoundaryFilter(name, 'electoralDistricts');
    this.showElectoralDropdown.set(false);
  }

  onElectoralDropdownBlur() {
    setTimeout(() => {
      this.showElectoralDropdown.set(false);
      const activeFilter = this.service.boundaryFilter();
      const activeLayer = this.service.boundaryFilterLayer();
      if (activeLayer === 'electoralDistricts') {
        this.activeElectoralQuery.set(activeFilter);
      } else {
        this.activeElectoralQuery.set('');
      }
    }, 200);
  }

  highlightText(text: string, query: string): string {
    return this.service.highlightText(text, query);
  }

  isLayerActive(layer: string): boolean {
    return this.service.activeBoundaryLayers().includes(layer);
  }

  toggleLayer(layer: string) {
    const current = this.service.activeBoundaryLayers();
    if (current.includes(layer)) {
      this.service.activeBoundaryLayers.set(current.filter(l => l !== layer));
      if (this.service.boundaryFilterLayer() === layer) {
        this.service.boundaryFilter.set('all');
        this.service.boundaryFilterLayer.set('none');
      }
    } else {
      this.service.activeBoundaryLayers.set([...current, layer]);
    }
  }
}
