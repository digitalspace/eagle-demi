import { Component, OnInit, OnDestroy, AfterViewInit, inject, effect } from '@angular/core';
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

  private map: any = null;
  private regionsLayer: any = null;
  private markerClusterGroup: any = null;
  private markersMap = new Map<any, any>();

  constructor() {
    // Re-sync map markers whenever our filtered projects or role change!
    effect(() => {
      const filtered = this.service.filteredProjects() || [];
      this.syncMarkersToMap(filtered);
      setTimeout(() => this.updateViewportProjects(), 100);
    });

    // Re-render regional boundaries whenever they are loaded or map is ready!
    effect(() => {
      const geojson = this.service.regionalBoundariesGeoJSON();
      if (geojson && this.map) {
        this.loadRegionalBoundaries();
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
      this.map.on('zoomend', onMove);
      
      setTimeout(() => this.updateViewportProjects(), 500);

      this.syncMarkersToMap(this.service.filteredProjects() || []);
      this.loadRegionalBoundaries();

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
        layer.bindTooltip(`<strong>${name} Region</strong>`, { sticky: true, className: 'region-tooltip' });

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

  highlightText(text: string, query: string): string {
    return this.service.highlightText(text, query);
  }
}
