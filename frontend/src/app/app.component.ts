import { Component, OnInit, signal, computed, effect } from '@angular/core';

// Declare global external libraries loaded via index.html CDN scripts
declare const Keycloak: any;
declare const L: any;

interface Project {
  id: string | number;
  name: string;
  sector: string;
  status: string;
  legacyEagleId: string;
  centroid: [number, number]; // [longitude, latitude]
  gatingState: 'admitted' | 'staged';
  region: string;
  description: string;
  proponent: string;
  rawMetadata?: any;
}

interface Document {
  id: string | number;
  displayName: string;
  documentFileName: string;
  documentType: string;
  orcsCode: string;
  projectId: string | number;
  projectName: string;
  gatingState: 'admitted' | 'staged';
  textSnippet: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  // Config paradigm states
  config = (window as any).__env || {};
  authEnabled = signal<boolean>(this.config.KEYCLOAK_ENABLED !== false);
  isAuthenticated = signal<boolean>(false);
  userName = signal<string>('');

  // UI Interactive States (using Signals)
  currentRole = signal<'public' | 'admin'>('public');
  activeTab = signal<'projects' | 'documents'>('projects');
  searchQuery = signal<string>('');
  gatingFilter = signal<'all' | 'admitted' | 'staged'>('all');
  sectorFilter = signal<string>('all');
  regionFilter = signal<string>('all');
  activePage = signal<'map' | 'search'>('map');

  availableRegions = ['Vancouver Island', 'Lower Mainland', 'Thompson', 'Kootenay', 'Cariboo', 'Skeena', 'Omineca', 'Okanagan', 'Peace'];

  // Datasets (using Signals - null representing loading sentinel)
  projects = signal<Project[] | null>(null);
  documents = signal<Document[] | null>(null);

  // Selected Items (using Signals)
  selectedProject = signal<Project | null>(null);
  selectedDocument = signal<Document | null>(null);

  // Map viewport states
  mapInViewProjectIds = signal<(string | number)[]>([]);

  // Keycloak reference
  private keycloak: any = null;
  private map: any = null;
  private regionsLayer: any = null;
  private markerClusterGroup: any = null;
  private markersMap = new Map<any, any>();

  // Fallback mock datasets
  private readonly mockProjects: Project[] = [
    {
      id: 111,
      name: "Ajax Mine",
      sector: "Mining",
      status: "Completed",
      legacyEagleId: "588510b0aaecd9001b8142a1",
      centroid: [-120.37, 50.62],
      gatingState: "admitted",
      region: "Thompson-Okanagan",
      description: "KGHM Ajax Mining Inc. proposes to develop a new open-pit copper and gold mine with a production capacity of up to 24 million tonnes of ore per year near Kamloops, British Columbia.",
      proponent: "KGHM Ajax Mining Inc."
    },
    {
      id: 207,
      name: "Nicomen Wind Energy",
      sector: "Energy",
      status: "In Progress",
      legacyEagleId: "58851172aaecd9001b820335",
      centroid: [-121.22, 50.25],
      gatingState: "admitted",
      region: "Thompson-Okanagan",
      description: "Wind energy generation project consisting of up to 40 wind turbines near Lytton, British Columbia.",
      proponent: "Nicomen Wind Energy Corp"
    },
    {
      id: 304,
      name: "Timicw Good Earth Recycling Landfill",
      sector: "Waste Management",
      status: "Completed",
      legacyEagleId: "64a5f1dc2d0a9c002225f25e",
      centroid: [-120.35, 51.10], // Moved slightly north to avoid complete overlap with Ajax
      gatingState: "admitted",
      region: "Thompson-Okanagan",
      description: "Recycling and composting facility aiming to process organic and wood wastes into usable agricultural additions.",
      proponent: "Good Earth Recycling Ltd"
    },
    {
      id: 307,
      name: "Tranquille on the Lake",
      sector: "Urban Development",
      status: "In Progress",
      legacyEagleId: "64f9f03e559cf40022effe76",
      centroid: [-120.48, 50.70],
      gatingState: "staged",
      region: "Thompson-Okanagan",
      description: "A comprehensive lakeside resort community master-planned development.",
      proponent: "Tranquille Developments"
    },
    {
      id: 333,
      name: "WCOL Natural Gas Liquids (NGL) Recovery",
      sector: "Energy",
      status: "In Progress",
      legacyEagleId: "620ef49aabfe9500223f403a",
      centroid: [-121.5, 55.7],
      gatingState: "admitted",
      region: "Peace",
      description: "Natural gas extraction, recovery and enrichment processing facility.",
      proponent: "West Coast Olefins Ltd"
    },
    {
      id: 336,
      name: "Westcoast Connector Gas Transmission",
      sector: "Energy",
      status: "Completed",
      legacyEagleId: "588511b7aaecd9001b824889",
      centroid: [-128.5, 54.5],
      gatingState: "admitted",
      region: "Skeena",
      description: "Natural gas pipeline proposal to transport gas from northeast BC to Prince Rupert.",
      proponent: "Spectra Energy"
    },
    {
      id: 401,
      name: "Coastal GasLink Pipeline",
      sector: "Energy",
      status: "Completed",
      legacyEagleId: "588511b8aaecd9001b8249a1",
      centroid: [-124.0, 54.0],
      gatingState: "admitted",
      region: "Skeena",
      description: "A 670-kilometre pipeline delivering natural gas from northeastern BC to the LNG Canada facility in Kitimat.",
      proponent: "TC Energy"
    },
    {
      id: 402,
      name: "Site C Clean Energy Project",
      sector: "Energy",
      status: "In Progress",
      legacyEagleId: "588511b9aaecd9001b824ab2",
      centroid: [-120.9, 56.2],
      gatingState: "admitted",
      region: "Peace",
      description: "Third dam and hydroelectric generating station on the Peace River in northeastern BC.",
      proponent: "BC Hydro"
    },
    {
      id: 403,
      name: "Blackwater Gold Project",
      sector: "Mining",
      status: "In Progress",
      legacyEagleId: "588511baaaecd9001b824bc3",
      centroid: [-124.8, 53.2],
      gatingState: "admitted",
      region: "Cariboo",
      description: "Gold and silver open-pit mine development located in central British Columbia.",
      proponent: "Artemis Gold Inc."
    },
    {
      id: 404,
      name: "KSM Project",
      sector: "Mining",
      status: "In Progress",
      legacyEagleId: "588511bbaaecd9001b824cd4",
      centroid: [-130.0, 56.5],
      gatingState: "staged",
      region: "Northwest",
      description: "One of the largest undeveloped gold and copper projects in the world, located in northwestern BC.",
      proponent: "Seabridge Gold Inc."
    }
  ];

  private readonly mockDocuments: Document[] = [
    {
      id: "doc-ajax-1",
      displayName: "Ajax Mine Project Assessment Report",
      documentFileName: "Ajax_Mine_Assessment_Report.pdf",
      documentType: "Assessment Report",
      orcsCode: "34800-20/AJAX",
      projectId: 111,
      projectName: "Ajax Mine",
      gatingState: "admitted",
      textSnippet: "This assessment report evaluates the environmental, social, economic, heritage, and health effects of the proposed KGHM Ajax Mine project near Kamloops, BC."
    },
    {
      id: "doc-ajax-2",
      displayName: "Environmental Certificate Application Summary",
      documentFileName: "Ajax_Certificate_Application_Summary.pdf",
      documentType: "Application",
      orcsCode: "34800-30/AJAX",
      projectId: 111,
      projectName: "Ajax Mine",
      gatingState: "admitted",
      textSnippet: "KGHM Ajax Mining Inc. submits this application summary for an Environmental Assessment Certificate for development of a copper-gold open-pit mine..."
    },
    {
      id: "doc1",
      displayName: "Environmental Assessment Certificate #14-02",
      documentFileName: "EA_Certificate_14-02_Nicomen.pdf",
      documentType: "Certificate",
      orcsCode: "35400-20/NICO",
      projectId: 207,
      projectName: "Nicomen Wind Energy",
      gatingState: "admitted",
      textSnippet: "Nicomen Wind Energy Corp is hereby authorized to construct and operate up to 40 wind turbines subject to the terms in Schedule A..."
    },
    {
      id: "doc2",
      displayName: "Acoustic Impact Assessment & Noise Model Report",
      documentFileName: "Nicomen_Wind_Acoustic_Noise_Model.pdf",
      documentType: "Assessment Report",
      orcsCode: "35400-30/NICO",
      projectId: 207,
      projectName: "Nicomen Wind Energy",
      gatingState: "admitted",
      textSnippet: "Acoustical models demonstrate noise levels at nearest residential receptors will not exceed 40 dBA under any operational wind configurations..."
    },
    {
      id: "doc3",
      displayName: "Draft Master Landfill Reclamation & Closure Plan",
      documentFileName: "GoodEarth_Landfill_Draft_Closure_Plan_V2.pdf",
      documentType: "Management Plan",
      orcsCode: "32600-40/RECY",
      projectId: 304,
      projectName: "Timicw Good Earth Recycling Landfill",
      gatingState: "admitted",
      textSnippet: "Plan details the progressive capping, gas monitoring, and final vegetation restoration of the landfill site starting in year 2028..."
    }
  ];

  // Dynamic Filtering Computations (Signals are automatically tracked!)
  filteredProjects = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const gating = this.gatingFilter();
    const sector = this.sectorFilter();
    const region = this.regionFilter();
    const role = this.currentRole();

    // For plain deep search view, return empty array until user starts typing
    if (this.activePage() === 'search' && !query) {
      return [];
    }

    const projs = this.projects();
    if (projs === null) return null;

    return projs.filter(p => {
      // 1. Role access gating
      if (role === 'public' && p.gatingState !== 'admitted') return false;

      // 2. Gating filter selection
      if (gating !== 'all' && p.gatingState !== gating) return false;

      // 3. Sector filter selection
      if (sector !== 'all' && p.sector !== sector) return false;

      // 3b. Region filter selection
      if (region !== 'all') {
        const pRegion = (p.region || '').toLowerCase();
        const fRegion = region.toLowerCase();
        // Allow flexible partial mapping
        if (!pRegion.includes(fRegion) && !fRegion.includes(pRegion)) {
          return false;
        }
      }

      // 4. Thorough free text search matching name, description, and ALL raw metadata attributes with Levenshtein typo tolerance!
      if (query) {
        const serialized = JSON.stringify(p);
        if (!this.fuzzyMatch(serialized, query)) return false;
      }

      return true;
    });
  });

  filteredDocuments = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const gating = this.gatingFilter();
    const role = this.currentRole();
    
    // Track active filtered projects to align document list with active map/region filters!
    const projs = this.filteredProjects() || [];
    const matchedProjectIds = new Set(projs.map(p => p.id));

    // For plain deep search view, return empty array until user starts typing
    if (this.activePage() === 'search' && !query) {
      return [];
    }

    const docs = this.documents();
    if (docs === null) return null;

    return docs.filter(d => {
      // Unify filtering: only show documents belonging to projects that match our current filters (sector, region, etc.)
      if (!matchedProjectIds.has(d.projectId)) return false;

      // 1. Role access gating
      if (role === 'public' && d.gatingState !== 'admitted') return false;

      // 2. Gating filter selection
      if (gating !== 'all' && d.gatingState !== gating) return false;

      // 3. Thorough free text matching title, snippet, and ALL nested document metadata attributes with Levenshtein typo tolerance!
      if (query) {
        const serialized = JSON.stringify(d);
        if (!this.fuzzyMatch(serialized, query)) return false;
      }

      return true;
    });
  });

  // Geospatial Statistics Computations
  viewportCount = computed(() => {
    const inViewIds = new Set(this.mapInViewProjectIds());
    return (this.filteredProjects() || []).filter(p => inViewIds.has(p.id)).length;
  });

  stagedCount = computed(() => {
    return (this.projects() || []).filter(p => p.gatingState === 'staged').length;
  });

  constructor() {
    // Manage map lifecycle based on active page view
    effect(() => {
      const page = this.activePage();
      if (page === 'map') {
        setTimeout(() => {
          this.initMap();
        }, 50);
      } else {
        this.destroyMap();
      }
    });

    // Re-sync map markers whenever our filtered projects or role change!
    effect(() => {
      if (this.activePage() === 'map') {
        this.syncMarkersToMap(this.filteredProjects() || []);
      }
    });
  }

  ngOnInit() {
    this.initKeycloak();
    this.loadData();
  }

  // Keycloak check-sso initialization Flow
  private initKeycloak() {
    if (!this.authEnabled()) return;

    try {
      this.keycloak = new Keycloak({
        url: this.config.KEYCLOAK_URL,
        realm: this.config.KEYCLOAK_REALM,
        clientId: this.config.KEYCLOAK_CLIENT_ID
      });

      this.keycloak.init({
        onLoad: 'check-sso',
        silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html',
        pkceMethod: 'S256'
      }).then((authenticated: boolean) => {
        // Clean URL parameters from OAuth state redirections
        this.cleanUrlParams();

        if (authenticated) {
          this.isAuthenticated.set(true);
          this.userName.set(this.keycloak.tokenParsed?.name || 'Staff User');
          this.currentRole.set('admin'); // Elevate view automatically on auth!
        }
      }).catch((err: any) => {
        console.warn('Keycloak initialization skipped / offline mode fallback:', err);
      });
    } catch (err) {
      console.warn('Keycloak client library unavailable:', err);
    }
  }

  private cleanUrlParams() {
    const url = new URL(window.location.href);
    if (url.hash) {
      const params = ['state', 'code', 'session_state', 'error'];
      let hash = url.hash.substring(1);
      params.forEach(p => {
        const reg = new RegExp('[#&]' + p + '=([^&#]*)', 'i');
        hash = hash.replace(reg, '');
      });
      window.history.replaceState({}, document.title, url.pathname + (hash ? '#' + hash : ''));
    }
  }

  // GIS Leaflet Map initialization
  private initMap() {
    try {
      // Centered on central British Columbia
      this.map = L.map('map', { zoomControl: false }).setView([54.0, -125.0], 5);
      
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
      }).addTo(this.map);

      L.control.zoom({ position: 'bottomright' }).addTo(this.map);

      // Track viewport coordinates changes to filter projects in view
      const updateViewportProjects = () => {
        if (!this.map) return;
        const bounds = this.map.getBounds();
        const inViewIds: (string | number)[] = [];

        (this.projects() || []).forEach(p => {
          const [lng, lat] = p.centroid;
          if (bounds.contains([lat, lng])) {
            inViewIds.push(p.id);
          }
        });
        this.mapInViewProjectIds.set(inViewIds);
      };

      this.map.on('moveend', updateViewportProjects);
      this.map.on('zoomend', updateViewportProjects);
      
      // Call once initially
      setTimeout(updateViewportProjects, 500);

      // Populate markers immediately on map initialization
      this.syncMarkersToMap(this.filteredProjects() || []);

      // Fetch and render reprojected environmental regional boundaries GeoJSON
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

  private async loadRegionalBoundaries() {
    try {
      const res = await fetch('/env_regional_boundaries_reprojected.geojson');
      if (!res.ok) throw new Error('Failed to load regional boundaries GeoJSON');
      const geojson = await res.json();

      if (!this.map) return;

      this.regionsLayer = L.geoJSON(geojson, {
        style: (feature: any) => this.getRegionStyle(feature?.properties?.regionName),
        onEachFeature: (feature: any, layer: any) => {
          const name = feature?.properties?.regionName;
          
          // Tooltip on hover
          layer.bindTooltip(`<strong>${name} Region</strong>`, { sticky: true, className: 'region-tooltip' });

          // Hover events
          layer.on({
            mouseover: (e: any) => {
              const ly = e.target;
              const currentFilter = this.regionFilter();
              if (currentFilter === 'all' || currentFilter.toLowerCase() === name.toLowerCase()) {
                ly.setStyle({
                  weight: 3,
                  color: '#fcba19', // glowing gold outline
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
              if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
                ly.bringToFront();
              }
            },
            mouseout: (e: any) => {
              const ly = e.target;
              this.regionsLayer.resetStyle(ly);
              ly.setStyle(this.getRegionStyle(name));
            },
            click: (e: any) => {
              const current = this.regionFilter();
              if (current.toLowerCase() === name.toLowerCase()) {
                this.setRegionFilter('all');
              } else {
                this.setRegionFilter(name);
              }
            }
          });
        }
      }).addTo(this.map);

      // Ensure regions layer stays under markers
      if (this.regionsLayer) {
        this.regionsLayer.bringToBack();
      }
    } catch (err) {
      console.error('Failed to load regional boundaries:', err);
    }
  }

  private getRegionStyle(regionName: string): any {
    const selected = this.regionFilter();
    const isSelected = selected !== 'all' && selected.toLowerCase() === (regionName || '').toLowerCase();
    const hasAnySelection = selected !== 'all';

    if (isSelected) {
      return {
        weight: 4.5,      // Extremely prominent thick border
        color: '#fcba19',   // BC Gold highlight
        opacity: 1.0,       // Solid border opacity
        fillColor: '#fcba19',
        fillOpacity: 0.14,  // Soft glowing background
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
      color: '#38598a', // BC Gov primary blue
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
    this.regionFilter.set(region);
    this.updateRegionsLayerStyle();
    this.loadData();
  }

  // Load datasets from Express api, falling back to rich mock data if empty/fails
  private async loadData() {
    const buildMockProjects = () => {
      return this.mockProjects.map(p => {
        const trackAttributes = {
          track_project_id: p.id,
          name: p.name,
          description: p.description,
          abbreviation: p.name.toUpperCase().substring(0, 4),
          proponent_name: p.proponent,
          region_name: p.region,
          type_name: p.sector,
          sub_type_name: p.sector,
          address: '1011 Government St, Victoria, BC',
          is_active: p.status === 'In Progress',
          lead_agency: 'BC Environmental Assessment Office (Mock Master)',
          decision_date: '2026-06-15T00:00:00Z'
        };

        const eagleAttributes = {
          _id: p.legacyEagleId,
          name: p.name,
          region: p.region,
          status: p.status,
          responsibleEPD: 'Project Assessment Director (Mock Cache)',
          locationDescription: p.region,
          centroid: p.centroid,
          _schemaName: 'Project',
          _createdDate: '2022-01-10T12:00:00Z',
          _updatedDate: '2026-07-01T15:30:00Z'
        };

        return {
          ...p,
          rawMetadata: {
            trackAttributes,
            eagleAttributes
          }
        };
      });
    };

    if (this.config.USE_MOCK_DATA) {
      console.log('[Registry] Standalone demo mode active. Loading mock dataset.');
      this.projects.set(buildMockProjects());
      this.documents.set(this.mockDocuments);
      return;
    }

    try {
      let basePath = '/api';
      if (this.config.API_PATH) {
        basePath = this.config.API_PATH;
      }

      console.log('[Registry] Loading real-time projects and documents from central dev database...');

      const q = this.searchQuery();
      const sector = this.sectorFilter();

      // Set null sentinel loading states!
      this.projects.set(null);
      this.documents.set(null);

      let projParams = `dataset=Project&pageSize=500`;
      if (q) projParams += `&keywords=${encodeURIComponent(q)}&fuzzy=true`;
      if (sector !== 'all') {
        projParams += `&and[sector]=${encodeURIComponent(sector)}`;
      }

      const resProj = await fetch(`${basePath}/search?${projParams}`, {
        headers: { 'X-Api-Key': 'eagle-demi-api-key' }
      });
      if (!resProj.ok) throw new Error(`Projects API returned status ${resProj.status}`);
      const apiProjects = await resProj.json();

      let resultsDoc = [];
      let docParams = `dataset=Document&pageSize=500`;
      if (q) {
        docParams += `&keywords=${encodeURIComponent(q)}&fuzzy=true`;
      }
      
      const resDoc = await fetch(`${basePath}/search?${docParams}`, {
        headers: { 'X-Api-Key': 'eagle-demi-api-key' }
      });
      if (!resDoc.ok) throw new Error(`Documents API returned status ${resDoc.status}`);
      const apiDocuments = await resDoc.json();
      resultsDoc = apiDocuments[0]?.searchResults || [];

      const resultsProj = apiProjects[0]?.searchResults || [];

      if (Array.isArray(resultsProj) && resultsProj.length > 0) {
        const mappedProjects: Project[] = resultsProj.map((p: any) => {
          // Extract nested metadata block from DEMI MongoDB which houses merged payloads!
          const rawMetadata = p.metadata || {
            trackAttributes: {
              track_project_id: p.trackProjectId || p.id || 'N/A',
              lead_agency: p.leadAgency || 'BC Environmental Assessment Office',
              decision_date: p.eaDecisionDate || null,
              name: p.name,
              description: p.description
            },
            eagleAttributes: {
              _id: p._id,
              name: p.name,
              responsibleEPD: p.responsibleEPD || 'Project Assessment Director',
              locationDescription: p.region || 'British Columbia',
              centroid: p.centroid
            }
          };

          return {
            id: p._id,
            name: p.name || 'Unnamed Project',
            sector: p.sector || rawMetadata.trackAttributes?.type_name || 'Other',
            status: p.status || rawMetadata.trackAttributes?.project_state_name || 'Active',
            legacyEagleId: p._id,
            centroid: p.centroid || [-125.0, 54.0],
            gatingState: 'admitted',
            region: p.region || 'British Columbia',
            description: p.description || rawMetadata.trackAttributes?.description || 'No project description provided.',
            proponent: p.proponent?.name || rawMetadata.trackAttributes?.proponent_name || 'Proponent Organization',
            rawMetadata: rawMetadata
          };
        });
        this.projects.set(mappedProjects);
      } else {
        this.projects.set([]);
      }

      if (Array.isArray(resultsDoc) && resultsDoc.length > 0) {
        const mappedDocs: Document[] = resultsDoc.map((d: any) => {
          const projId = d.project || '';
          const matchedProj = (this.projects() || []).find(p => p.id === projId || p.legacyEagleId === projId);
          const resolvedProjectName = matchedProj ? matchedProj.name : (d.projectName || 'Associated Project');

          return {
            id: d._id,
            displayName: d.displayName || d.documentFileName || 'Untitled Document',
            documentFileName: d.documentFileName || 'document.pdf',
            documentType: 'PDF Document',
            orcsCode: d.orcsClassification || '34800-20/MOCK',
            projectId: projId,
            projectName: resolvedProjectName,
            gatingState: 'admitted',
            textSnippet: d.description || 'This is an extracted document from the central registry.'
          };
        });
        this.documents.set(mappedDocs);
      } else {
        this.documents.set([]);
      }
    } catch (err) {
      console.warn('API search fetch failed. Loading premium fallback mock database:', err);
      this.projects.set(buildMockProjects());
      this.documents.set(this.mockDocuments);
    }
  }

  // Sync Leaflet markers to reflect current filtered project list with Marker Clustering!
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

    // Remove old markers that are no longer active
    const activeIds = new Set(filteredProjects.map(p => p.id));
    this.markersMap.forEach((marker, id) => {
      if (!activeIds.has(id)) {
        this.markerClusterGroup.removeLayer(marker);
        this.markersMap.delete(id);
      }
    });

    // Add or update active markers
    filteredProjects.forEach(p => {
      const [lng, lat] = p.centroid;

      if (!this.markersMap.has(p.id)) {
        const customIcon = L.divIcon({
          className: 'custom-marker',
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

  // UI Event Handlers
  private resetSelection() {
    this.selectedProject.set(null);
    this.selectedDocument.set(null);
  }

  setDemoRole(role: 'public' | 'admin') {
    if (role === 'admin' && this.authEnabled() && !this.isAuthenticated()) {
      // Trigger Interactive Keycloak Login!
      this.keycloak.login({
        redirectUri: window.location.origin + '/admin'
      });
    } else {
      this.currentRole.set(role);
      this.resetSelection();
    }
  }

  setActiveTab(tab: 'projects' | 'documents') {
    this.activeTab.set(tab);
    this.resetSelection();
  }

  setPage(page: 'map' | 'search') {
    this.activePage.set(page);
    this.resetSelection();
  }

  private searchDebounceTimer: any = null;

  onSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.searchQuery.set(value);

    // Set null sentinel loading state immediately!
    this.projects.set(null);
    if (value) {
      this.documents.set(null);
    } else {
      this.documents.set([]);
    }

    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.loadData();
    }, 300);
  }

  setGatingFilter(state: 'all' | 'admitted' | 'staged') {
    this.gatingFilter.set(state);
  }

  setSectorFilter(sector: string) {
    this.sectorFilter.set(sector);
    this.loadData();
  }

  selectProject(proj: Project) {
    this.selectedProject.set(proj);
    this.selectedDocument.set(null);

    // Pan map to centroid
    if (this.map) {
      const [lng, lat] = proj.centroid;
      this.map.setView([lat, lng], 8, { animate: true });

      // Highlight corresponding marker popup
      const marker = this.markersMap.get(proj.id);
      if (marker) {
        marker.openPopup();
      }
    }
  }

  selectDocument(doc: Document) {
    this.selectedDocument.set(doc);
    this.selectedProject.set(null);
  }

  viewProjectDocuments(proj: Project) {
    this.setActiveTab('documents');
    this.searchQuery.set(proj.name);
  }

  getProjDocCount(projId: string | number): number {
    return (this.documents() || []).filter(d => d.projectId === projId).length;
  }

  getFullJson(proj: Project): string {
    if (!proj || !proj.rawMetadata) return '{}';
    return JSON.stringify(proj.rawMetadata, null, 2);
  }

  highlightText(text: string, query: string): string {
    if (!text) return '';
    
    // If the text already has <mark> tags from Typesense, sanitize and preserve them
    if (text.includes('<mark>') || text.includes('</mark>') || text.includes('<MARK>') || text.includes('</MARK>')) {
      return this.sanitizeHighlight(text);
    }

    const escaped = this.escapeHtml(text);
    if (!query) return escaped;

    const tokens = query
      .split(/\s+/)
      .filter(t => t.length > 0)
      .map(t => this.escapeRegex(t));

    if (!tokens.length) return escaped;

    // Wrap matching terms in <mark> tags safely
    const pattern = new RegExp(`(${tokens.join('|')})`, 'gi');
    return escaped.replace(pattern, '<mark>$1</mark>');
  }

  sanitizeHighlight(html: string): string {
    if (!html) return '';
    const parts = html.split(/(<\/?mark>)/gi);
    let result = '';
    for (const part of parts) {
      if (/^<mark>$/i.test(part)) {
        result += '<mark>';
      } else if (/^<\/mark>$/i.test(part)) {
        result += '</mark>';
      } else {
        const stripped = part.replace(/<[^>]*>/g, '');
        result += this.decodeHtmlEntities(stripped);
      }
    }
    return result;
  }

  private decodeHtmlEntities(text: string): string {
    const named: Record<string, string> = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
      ndash: '\u2013', mdash: '\u2014',
      rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201D', ldquo: '\u201C',
      hellip: '\u2026', bull: '\u2022', middot: '\u00B7',
      copy: '\u00A9', reg: '\u00AE', trade: '\u2122',
      eacute: '\u00E9', Eacute: '\u00C9', aacute: '\u00E1', Aacute: '\u00C1',
      iacute: '\u00ED', Iacute: '\u00CD', oacute: '\u00F3', Oacute: '\u00D3',
      uacute: '\u00FA', Uacute: '\u00DA', agrave: '\u00E0', egrave: '\u00E8',
      ntilde: '\u00F1', Ntilde: '\u00D1', ouml: '\u00F6', Ouml: '\u00D6',
      auml: '\u00E4', Auml: '\u00C4', uuml: '\u00FC', Uuml: '\u00DC',
      ccedil: '\u00E7', Ccedil: '\u00C7', szlig: '\u00DF',
    };
    return text
      .replace(/&([a-zA-Z]+);/g, (_, n) => named[n] ?? named[n.toLowerCase()] ?? `&${n};`)
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private escapeHtml(text: string): string {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }



  levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  fuzzyMatch(text: string, query: string): boolean {
    if (!text || !query) return false;
    const cleanText = text.toLowerCase();
    const cleanQuery = query.toLowerCase();
    if (cleanText.includes(cleanQuery)) return true;

    const queryTokens = cleanQuery.split(/\s+/).filter(t => t.length > 2);
    if (queryTokens.length === 0) return false;

    // Filter out punctuation and keep alphanumeric words
    const textWords = cleanText.split(/[^a-z0-9]+/).filter(w => w.length > 2);

    return queryTokens.every(qToken => {
      return textWords.some(word => {
        if (word.startsWith(qToken)) return true;
        const maxDist = qToken.length >= 5 ? 2 : 1;
        return this.levenshtein(word, qToken) <= maxDist;
      });
    });
  }

  logout() {
    if (this.keycloak) {
      this.keycloak.logout({
        redirectUri: window.location.origin
      });
    }
  }
}
