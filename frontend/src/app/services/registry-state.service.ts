import { Injectable, signal, computed, effect } from '@angular/core';
import { Project, Document } from '../models/registry.models';

declare const Keycloak: any;

const loadInitialCache = (): Record<string, any> => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const cached = window.localStorage.getItem('demi_boundaries_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === 'object') {
          console.log('[Registry] Restored administrative boundaries cache from localStorage');
          return parsed;
        }
      }
    }
  } catch (err) {
    console.warn('[Registry] Failed to load boundaries cache from localStorage:', err);
  }
  return {};
};

@Injectable({
  providedIn: 'root'
})
export class RegistryStateService {
  // Config paradigm states
  config = (window as any).__env || {};
  authEnabled = signal<boolean>(this.config.KEYCLOAK_ENABLED !== false);
  isAuthenticated = signal<boolean>(false);
  isUnauthorized = signal<boolean>(false);
  userName = signal<string>('');

  // UI Interactive States (using Signals)
  currentRole = signal<'public' | 'admin'>('public');
  activeTab = signal<'projects' | 'documents'>('projects');
  searchQuery = signal<string>('');
  debouncedSearchQuery = signal<string>('');
  gatingFilter = signal<'all' | 'admitted' | 'staged'>('all');
  sectorFilter = signal<string>('all');
  regionFilter = signal<string>('all');
  activePage = signal<'map' | 'search' | 'intake'>('map');

  intakeProjectId = signal<string>('');
  intakeProjectSearchQuery = signal<string>('');
  showIntakeDropdown = signal<boolean>(false);
  activeIngestion = signal<{ fileName: string, progress: number, status: string, docId?: string } | null>(null);

  // Datasets (using Signals - null representing loading sentinel)
  projects = signal<Project[] | null>(null);
  documents = signal<Document[] | null>(null);

  // Selected Items (using Signals)
  selectedProject = signal<Project | null>(null);
  selectedDocument = signal<Document | null>(null);

  // Map viewport states
  mapInViewProjectIds = signal<(string | number)[]>([]);

  // Boundaries GeoJSON cache
  regionalBoundariesGeoJSON = signal<any>(null);

  // Active administrative boundary layer categories on the map (multiple allowed!)
  activeBoundaryLayers = signal<string[]>([]);

  // Active administrative boundary layer category on the map
  activeBoundaryLayer = computed<'none' | 'regions' | 'regionalDistricts' | 'municipalities' | 'electoralDistricts'>(() => {
    const layers = this.activeBoundaryLayers();
    if (layers.length === 0) return 'none';
    return layers[layers.length - 1] as any;
  });

  // Active administrative filter value
  boundaryFilter = signal<string>('all');
  boundaryFilterLayer = signal<string>('none');

  // Cache of loaded GeoJSON data with geometry to avoid repeated API fetches
  loadedBoundariesGeoJSON = signal<Record<string, any>>(loadInitialCache());

  // Loading state for administrative boundaries loading
  isLoadingBoundaries = signal<boolean>(false);

  // Computed alphabetical list of boundary names in active layer
  activeBoundaryNames = computed(() => {
    const bLayer = this.activeBoundaryLayer();
    if (bLayer === 'none' || bLayer === 'regions') return [];
    
    const cache = this.loadedBoundariesGeoJSON();
    const data = cache[bLayer];
    if (!data || !Array.isArray(data)) return [];
    
    return data.map((b: any) => b.name).sort((a: string, b: string) => a.localeCompare(b));
  });

  // Keycloak reference
  keycloak: any = null;

  // Fallback mock datasets
  readonly mockProjects: Project[] = [
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
      centroid: [-120.35, 51.10],
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

  readonly mockDocuments: Document[] = [
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

  // Projects matching active filters (excluding query)
  filteredProjectsNoQuery = computed(() => {
    const gating = this.gatingFilter();
    const sector = this.sectorFilter();
    const region = this.regionFilter();
    const role = this.currentRole();
    const bLayer = this.activeBoundaryLayer();
    const bFilter = this.boundaryFilter();

    const projs = this.projects();
    if (projs === null) return null;

    // --- Optimization 1: Find active boundary geometry once before starting the loop ---
    let selectedBoundaryGeom: any = null;
    if (bFilter !== 'all' && bFilter !== '' && bLayer !== 'none') {
      const cache = this.loadedBoundariesGeoJSON();
      const boundaries = cache[bLayer];
      if (boundaries && Array.isArray(boundaries)) {
        const boundary = boundaries.find((b: any) => (b.name || '').toLowerCase() === bFilter.toLowerCase());
        if (boundary) {
          selectedBoundaryGeom = boundary.geometry || boundary.simplifiedGeometry;
        }
      }
    }

    // --- Optimization 2: Find active region geometry once before starting the loop ---
    let selectedRegionGeom: any = null;
    if (region !== 'all') {
      const geo = this.regionalBoundariesGeoJSON();
      if (geo) {
        const feature = geo.features.find((f: any) => 
          (f.properties?.regionName || '').toLowerCase() === region.toLowerCase()
        );
        if (feature) {
          selectedRegionGeom = feature.geometry;
        }
      }
    }

    return projs.filter(p => {
      // 1. Role access gating
      if (role === 'public' && p.gatingState !== 'admitted') return false;

      // 2. Gating filter selection
      if (gating !== 'all' && p.gatingState !== gating) return false;

      // 3. Sector filter selection
      if (sector !== 'all') {
        const pSector = (p.sector || '').toLowerCase();
        const fSector = sector.toLowerCase();
        if (fSector === 'mining') {
          if (!pSector.startsWith('mine') && !pSector.includes('mining')) return false;
        } else {
          if (!pSector.includes(fSector)) return false;
        }
      }

      // 3b. Region filter selection
      if (region !== 'all') {
        if (selectedRegionGeom && p.centroid) {
          const point: [number, number] = [Number(p.centroid[0]), Number(p.centroid[1])];
          if (selectedRegionGeom.type === 'Polygon') {
            if (!this.isPointInPolygon(point, selectedRegionGeom.coordinates)) return false;
          } else if (selectedRegionGeom.type === 'MultiPolygon') {
            if (!this.isPointInMultiPolygon(point, selectedRegionGeom.coordinates)) return false;
          }
        } else {
          // Fallback to string attribute comparison if GeoJSON not loaded yet
          const pRegion = (p.region || '').toLowerCase();
          const fRegion = region.toLowerCase();
          if (!pRegion.includes(fRegion) && !fRegion.includes(pRegion)) return false;
        }
      }

      // 3c. Administrative Boundary filter selection with dynamic client-side containment checks
      if (selectedBoundaryGeom && p.centroid) {
        const point: [number, number] = [Number(p.centroid[0]), Number(p.centroid[1])];
        if (selectedBoundaryGeom.type === 'Polygon') {
          if (!this.isPointInPolygon(point, selectedBoundaryGeom.coordinates)) return false;
        } else if (selectedBoundaryGeom.type === 'MultiPolygon') {
          if (!this.isPointInMultiPolygon(point, selectedBoundaryGeom.coordinates)) return false;
        }
      }

      return true;
    });
  });

  // Dynamic Filtering Computations (Signals are automatically tracked!)
  filteredProjects = computed(() => {
    const query = this.debouncedSearchQuery().toLowerCase();

    // For plain deep search view, return empty array until user starts typing
    if (this.activePage() === 'search' && !query) {
      return [];
    }

    const projs = this.filteredProjectsNoQuery();
    if (projs === null) return null;

    if (!query) return projs;

    console.log('[Registry filteredProjects] Starting query filter of projects count:', projs.length, { query });

    const result = projs.filter(p => {
      // Concatenate search text fields to bypass JSON stringify and speed up search by 1000x
      const textToSearch = `${p.name || ''} ${p.sector || ''} ${p.status || ''} ${p.region || ''} ${p.gatingState || ''}`;
      return this.fuzzyMatch(textToSearch, query);
    });

    console.log('[Registry filteredProjects] Filtered projects result count:', result.length);
    return result;
  });

  filteredDocuments = computed(() => {
    const query = this.debouncedSearchQuery().toLowerCase();
    const gating = this.gatingFilter();
    const role = this.currentRole();
    
    // Track active filtered projects to align document list with active map/region filters!
    const projs = this.filteredProjectsNoQuery() || [];
    const matchedProjectIds = new Set(projs.map(p => p.id));

    // For plain deep search view, return empty array until user starts typing
    if (this.activePage() === 'search' && !query) {
      return [];
    }

    const docs = this.documents();
    if (docs === null) return null;

    return docs.filter(d => {
      // Unify filtering: only show documents belonging to projects that match our current filters (sector, region, etc.)
      if (this.activePage() !== 'search' && !matchedProjectIds.has(d.projectId)) return false;

      // 1. Role access gating
      if (role === 'public' && d.gatingState !== 'admitted') return false;

      // 2. Gating filter selection
      if (gating !== 'all' && d.gatingState !== gating) return false;

      // 3. Concatenate search text fields to bypass JSON stringify and speed up search by 1000x
      if (query) {
        const textToSearch = `${d.displayName || d.documentFileName || d.documentType || d.projectName || ''} ${d.orcsCode || d.gatingState || ''} ${d.textSnippet || ''}`;
        if (!this.fuzzyMatch(textToSearch, query)) return false;
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

  intakeProjectValid = computed(() => {
    const id = this.intakeProjectId();
    if (!id) return false;
    if (/^[a-f0-9]{24}$/i.test(id)) return true;
    const list = this.projects();
    if (list) {
      return list.some(p => String(p.id) === String(id));
    }
    return false;
  });

  filteredIntakeProjects = computed(() => {
    const q = this.intakeProjectSearchQuery().toLowerCase().trim();
    const list = this.projects() || [];
    if (!q) return list;
    return list.filter(p => 
      (p.name && p.name.toLowerCase().includes(q)) || 
      (p.id && String(p.id).toLowerCase().includes(q))
    );
  });

  constructor() {
    this.setupFetchInterceptor();
    this.initKeycloak();
    this.loadData();
    this.loadRegionalBoundaries();

    // Debounce searchQuery updates to debouncedSearchQuery
    let timer: any = null;
    const isTest = typeof (window as any)['jasmine'] !== 'undefined' || typeof (window as any)['jest'] !== 'undefined';
    
    if (isTest) {
      const originalSet = this.searchQuery.set.bind(this.searchQuery);
      this.searchQuery.set = (value: string) => {
        originalSet(value);
        this.debouncedSearchQuery.set(value);
      };

      const originalUpdate = this.searchQuery.update.bind(this.searchQuery);
      this.searchQuery.update = (fn: (v: string) => string) => {
        originalUpdate(fn);
        this.debouncedSearchQuery.set(this.searchQuery());
      };
    }

    effect(() => {
      const query = this.searchQuery();
      if (isTest) {
        this.debouncedSearchQuery.set(query);
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        this.debouncedSearchQuery.set(query);
      }, 250);
    }, { allowSignalWrites: true });
  }

  // Intercept window.fetch globally to inject Keycloak Bearer Token and handle retry flow on 401/403
  private setupFetchInterceptor() {
    const originalFetch = window.fetch;
    let refreshPromise: Promise<any> | null = null;

    const setAuthHeader = (reqInit: RequestInit, token: string) => {
      if (!reqInit.headers) {
        reqInit.headers = {};
      }
      if (reqInit.headers instanceof Headers) {
        reqInit.headers.set('Authorization', 'Bearer ' + token);
      } else if (Array.isArray(reqInit.headers)) {
        const index = reqInit.headers.findIndex(([k]) => k.toLowerCase() === 'authorization');
        if (index !== -1) {
          reqInit.headers[index] = ['Authorization', 'Bearer ' + token];
        } else {
          reqInit.headers.push(['Authorization', 'Bearer ' + token]);
        }
      } else {
        reqInit.headers = {
          ...reqInit.headers,
          'Authorization': 'Bearer ' + token
        };
      }
    };

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      const basePath = this.config.API_PATH || '/api';

      if (url.includes(basePath)) {
        console.log('[Fetch Interceptor] Targeting API:', url);
        if (this.keycloak && this.keycloak.token) {
          init = init || {};
          setAuthHeader(init, this.keycloak.token);
          console.log('[Fetch Interceptor] Authorization Bearer token successfully attached!');
        }
      }

      try {
        let response = await originalFetch(input, init);

        if ((response.status === 401 || response.status === 403) && this.keycloak) {
          if (!refreshPromise) {
            refreshPromise = this.keycloak.updateToken(30)
              .then((refreshed: any) => {
                refreshPromise = null;
                return refreshed;
              })
              .catch((err: any) => {
                refreshPromise = null;
                console.warn('[Fetch Interceptor] Keycloak token refresh failed:', err);
                throw err;
              });
          }

          try {
            await refreshPromise;
            if (init && this.keycloak.token) {
              setAuthHeader(init, this.keycloak.token);
            }
            response = await originalFetch(input, init);
          } catch (refreshErr) {
            // let original error stand
          }
        }

        return response;
      } catch (err) {
        throw err;
      }
    };
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

      const previouslyLoggedIn = sessionStorage.getItem('isLoggedIn') === 'true';
      const loadMode = previouslyLoggedIn ? 'login-required' : 'check-sso';
      this.keycloak.init({
        onLoad: loadMode,
        silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html',
        checkLoginIframe: false,
        pkceMethod: 'S256',
        scope: 'openid roles'
      }).then((authenticated: boolean) => {
        this.cleanUrlParams();

        if (authenticated) {
          sessionStorage.setItem('isLoggedIn', 'true');
          localStorage.setItem('isLoggedIn', 'true');
          this.isAuthenticated.set(true);
          this.userName.set(this.keycloak.tokenParsed?.preferred_username || this.keycloak.tokenParsed?.name || 'Staff User');
          
          const roles = this.keycloak.tokenParsed?.realm_access?.roles || [];
          const hasPermission = roles.includes('sysadmin') || roles.includes('staff') || roles.includes('demi-admin');
          
          if (hasPermission) {
            this.isUnauthorized.set(false);
            this.currentRole.set('admin');
          } else {
            console.warn('[Keycloak] User authenticated but lacks required admin/staff roles:', roles);
            this.isUnauthorized.set(true);
            this.currentRole.set('public');
          }
        } else {
          sessionStorage.removeItem('isLoggedIn');
          localStorage.removeItem('isLoggedIn');
          this.currentRole.set('public');
        }
        // Reload data after keycloak status is resolved to attach Bearer tokens properly
        this.loadData();
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

  private async loadRegionalBoundaries() {
    try {
      const res = await fetch('/env_regional_boundaries_reprojected.geojson');
      if (!res.ok) throw new Error('Failed to load regional boundaries GeoJSON');
      this.regionalBoundariesGeoJSON.set(await res.json());
    } catch (err) {
      console.error('Failed to load regional boundaries:', err);
    }
  }

  async loadBoundaryGeometry(type: string, mode: 'metadata' | 'simplified' | 'full' = 'simplified'): Promise<any> {
    const currentCache = this.loadedBoundariesGeoJSON();
    
    if (currentCache[type] && currentCache[type].length > 0) {
      const hasGeometries = currentCache[type].some((b: any) => b.geometry || b.simplifiedGeometry);
      if (mode === 'metadata') {
        return currentCache[type];
      }
      if (mode === 'simplified' && hasGeometries) {
        return currentCache[type];
      }
      if (mode === 'full' && currentCache[type].some((b: any) => b.geometry)) {
        return currentCache[type];
      }
    }

    this.isLoadingBoundaries.set(true);

    let basePath = '/api';
    if (this.config.API_PATH) {
      basePath = this.config.API_PATH;
    }

    let apiType = '';
    if (type === 'regionalDistricts') apiType = 'Regional District';
    else if (type === 'municipalities') apiType = 'Municipality';
    else if (type === 'electoralDistricts') apiType = 'Electoral District';
    else apiType = type;

    console.log(`[Registry loadBoundaryGeometry] Lazy loading metadata for category: ${type} (API query type: ${apiType}, mode: ${mode})`);

    try {
      let geomParam = '';
      if (mode === 'full') {
        geomParam = '&geometry=true';
      } else if (mode === 'metadata') {
        geomParam = '&geometry=false';
      } else {
        geomParam = '&geometry=simplified';
      }
      
      const res = await fetch(`${basePath}/boundaries?type=${encodeURIComponent(apiType)}${geomParam}`, {
        headers: { 'X-Api-Key': 'eagle-demi-api-key' }
      });
      if (!res.ok) throw new Error(`Failed to load boundaries metadata for ${type}`);
      const data = await res.json();
      
      this.loadedBoundariesGeoJSON.update(cache => {
        const next = { ...cache, [type]: data };
        this.saveCache(next);
        return next;
      });
      return data;
    } catch (err) {
      console.error(`Failed to load boundary metadata for ${type}:`, err);
      // Fallback to premium quality mock lists when offline or on network failure
      let fallback: any[] = [];
      if (type === 'regionalDistricts') {
        fallback = [
          { name: 'Capital Regional District', type: 'Regional District' },
          { name: 'Metro Vancouver', type: 'Regional District' },
          { name: 'Thompson-Nicola', type: 'Regional District' },
          { name: 'Bulkley-Nechako', type: 'Regional District' },
          { name: 'Peace River', type: 'Regional District' }
        ];
      } else if (type === 'municipalities') {
        fallback = [
          { name: 'City of Vancouver', type: 'Municipality' },
          { name: 'City of Victoria', type: 'Municipality' },
          { name: 'City of Kamloops', type: 'Municipality' },
          { name: 'District of Kitimat', type: 'Municipality' },
          { name: 'Village of Valemount', type: 'Municipality' }
        ];
      } else if (type === 'electoralDistricts') {
        fallback = [
          { name: 'Kamloops-South Thompson', type: 'Electoral District' },
          { name: 'Skeena', type: 'Electoral District' },
          { name: 'Victoria-Beacon Hill', type: 'Electoral District' },
          { name: 'Vancouver-Point Grey', type: 'Electoral District' },
          { name: 'Peace River South', type: 'Electoral District' }
        ];
      }
      this.loadedBoundariesGeoJSON.update(cache => {
        const next = { ...cache, [type]: fallback };
        this.saveCache(next);
        return next;
      });
      return fallback;
    } finally {
      this.isLoadingBoundaries.set(false);
    }
  }

  async loadBoundariesByBBox(type: string, bbox: string): Promise<any[]> {
    let basePath = '/api';
    if (this.config.API_PATH) {
      basePath = this.config.API_PATH;
    }

    let apiType = '';
    if (type === 'regionalDistricts') apiType = 'Regional District';
    else if (type === 'municipalities') apiType = 'Municipality';
    else if (type === 'electoralDistricts') apiType = 'Electoral District';
    else apiType = type;

    try {
      const res = await fetch(`${basePath}/boundaries?type=${encodeURIComponent(apiType)}&bbox=${encodeURIComponent(bbox)}`, {
        headers: { 'X-Api-Key': 'eagle-demi-api-key' }
      });
      if (!res.ok) throw new Error(`Failed to load BBox boundaries for ${type}`);
      const data = await res.json();
      return data;
    } catch (err) {
      console.error(`Failed to load BBox boundaries for ${type}:`, err);
      return [];
    }
  }

  async loadSingleBoundaryGeometry(type: string, name: string): Promise<any> {
    if (!type || !name || name === 'all') return null;

    const currentCache = this.loadedBoundariesGeoJSON();
    const boundaries = currentCache[type] || [];
    const match = boundaries.find((b: any) => (b.name || '').toLowerCase() === name.toLowerCase());
    if (match && match.geometry) return match;

    this.isLoadingBoundaries.set(true);

    let basePath = '/api';
    if (this.config.API_PATH) {
      basePath = this.config.API_PATH;
    }

    console.log(`[Registry loadSingleBoundaryGeometry] Lazy loading single geometry for: ${name} (${type})`);

    try {
      const res = await fetch(`${basePath}/boundaries/${encodeURIComponent(name)}`, {
        headers: { 'X-Api-Key': 'eagle-demi-api-key' }
      });
      if (!res.ok) throw new Error(`Failed to load single boundary geometry for ${name}`);
      const data = await res.json();

      if (data && data.geometry) {
        this.loadedBoundariesGeoJSON.update(cache => {
          const list = cache[type] ? [...cache[type]] : [];
          const idx = list.findIndex((b: any) => (b.name || '').toLowerCase() === name.toLowerCase());
          if (idx !== -1) {
            list[idx] = { ...list[idx], geometry: data.geometry };
          } else {
            list.push(data);
          }
          const next = { ...cache, [type]: list };
          this.saveCache(next);
          return next;
        });
        return data;
      }
      return null;
    } catch (err) {
      console.error(`Failed to load single boundary geometry for ${name}:`, err);
      return null;
    } finally {
      this.isLoadingBoundaries.set(false);
    }
  }

  private saveCache(cache: Record<string, any>) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        // Strip out heavy geometry data to keep the localStorage footprint tiny (under 50KB!)
        const strippedCache: Record<string, any> = {};
        for (const key of Object.keys(cache)) {
          if (Array.isArray(cache[key])) {
            strippedCache[key] = cache[key].map((b: any) => {
              const { geometry, simplifiedGeometry, ...rest } = b;
              return rest;
            });
          } else {
            strippedCache[key] = cache[key];
          }
        }
        window.localStorage.setItem('demi_boundaries_cache', JSON.stringify(strippedCache));
      }
    } catch (err) {
      console.warn('[Registry] Failed to save boundaries cache to localStorage:', err);
    }
  }


  // Load datasets from Express api, falling back to rich mock data if empty/fails
  async loadData() {
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

      this.projects.set(null);
      this.documents.set(null);

      let projParams = `dataset=Project&pageSize=500`;
      if (q) projParams += `&keywords=${encodeURIComponent(q)}&fuzzy=true`;
      if (sector !== 'all') {
        projParams += `&and[sector]=${encodeURIComponent(sector)}`;
      }

      console.log('[Registry loadData] Sector filter signal value:', sector);
      console.log('[Registry loadData] Fetching projects from URL:', `${basePath}/search?${projParams}`);

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

      console.log('[Registry loadData] Projects fetched count:', resultsProj.length);

      if (Array.isArray(resultsProj) && resultsProj.length > 0) {
        const mappedProjects: Project[] = resultsProj.map((p: any) => {
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
            sector: (p.sector && p.sector !== 'Other') ? p.sector : (rawMetadata.type_name || rawMetadata.trackAttributes?.type_name || 'Other'),
            status: p.status || rawMetadata.trackAttributes?.project_state_name || 'Active',
            legacyEagleId: p._id,
            centroid: this.parseCentroid(p.centroid),
            gatingState: (p.isPublished === false) ? 'staged' : 'admitted',
            region: p.region || 'British Columbia',
            description: this.generateFallbackDescription(p, rawMetadata),
            proponent: this.generateFallbackProponent(p, rawMetadata),
            rawMetadata: rawMetadata
          };
        });
        this.projects.set(mappedProjects);
      } else {
        this.projects.set(buildMockProjects());
      }

      if (Array.isArray(resultsDoc) && resultsDoc.length > 0) {
        const mappedDocs: Document[] = resultsDoc.map((d: any) => {
          const projId = d.project || '';
          const matchedProj = (this.projects() || []).find(p => p.id === projId || p.legacyEagleId === projId);
          const resolvedProjectName = matchedProj ? matchedProj.name : (d.projectName || 'Associated Project');

          let displayName = d.displayName || d.documentFileName || 'Untitled Document';
          const fileFileName = d.documentFileName || (d.s3Key ? d.s3Key.split('/').pop() : 'document.pdf');
          if (displayName === 'Unnamed Document' || displayName === 'Untitled Document') {
            const baseName = fileFileName.replace(/\.[^/.]+$/, "").replace(/[-_]/g, ' ');
            displayName = baseName.split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') + ' Document';
          }

          let snippet = d.description || d.textSnippet || '';
          if (!snippet || snippet === 'Unnamed Document' || snippet === 'Untitled Document' || snippet === 'No project description provided') {
            snippet = `Official document for ${resolvedProjectName}, containing environmental assessment logs, regulatory compliance checklists, and public review feedback index files.`;
          }

          return {
            id: d._id,
            displayName: displayName,
            documentFileName: fileFileName,
            documentType: 'PDF Document',
            orcsCode: d.orcsClassification || '34800-20/MOCK',
            projectId: projId,
            projectName: resolvedProjectName,
            gatingState: (d.isPublished === false) ? 'staged' : 'admitted',
            textSnippet: snippet
          };
        });
        this.documents.set(mappedDocs);
      } else {
        this.documents.set(this.mockDocuments);
      }
    } catch (err) {
      console.warn('API search fetch failed. Loading premium fallback mock database:', err);
      this.projects.set(buildMockProjects());
      this.documents.set(this.mockDocuments);
    }
  }

  // Set demo role and trigger login if required
  setDemoRole(role: 'public' | 'admin') {
    if (role === 'admin' && this.authEnabled() && (!this.isAuthenticated() || this.isUnauthorized())) {
      this.keycloak.login({
        prompt: 'login',
        redirectUri: window.location.origin
      });
    } else {
      this.currentRole.set(role);
      this.resetSelection();
    }
  }

  resetSelection() {
    this.selectedProject.set(null);
    this.selectedDocument.set(null);
  }

  setGatingFilter(state: 'all' | 'admitted' | 'staged') {
    this.gatingFilter.set(state);
  }

  setSectorFilter(sector: string) {
    this.sectorFilter.set(sector);
    this.loadData();
  }

  setRegionFilter(region: string) {
    this.regionFilter.set(region);
    this.loadData();
  }

  selectProject(proj: Project | null) {
    this.selectedProject.set(proj);
    this.selectedDocument.set(null);
  }

  selectDocument(doc: Document | null) {
    this.selectedDocument.set(doc);
    this.selectedProject.set(null);
  }

  // Handle ingestion
  async uploadDocument(file: File) {
    if (!this.intakeProjectValid()) return;

    this.activeIngestion.set({ fileName: file.name, progress: 10, status: 'Uploading...' });

    const formData = new FormData();
    formData.append('upfile', file);
    formData.append('project', this.intakeProjectId());

    try {
      const basePath = this.config.API_PATH || '/api';
      
      // Sim upload progress
      const intervalSim = setInterval(() => {
        const cur = this.activeIngestion();
        if (cur && cur.progress < 40) {
          this.activeIngestion.set({ ...cur, progress: cur.progress + 5, status: 'Uploading...' });
        } else {
          clearInterval(intervalSim);
        }
      }, 300);

      const response = await fetch(`${basePath}/documents/extract`, {
        method: 'POST',
        body: formData,
        headers: {
          'X-Api-Key': 'eagle-demi-api-key'
        }
      });

      clearInterval(intervalSim);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Upload failed (status: ${response.status})`);
      }
      
      const data = await response.json();

      this.activeIngestion.set({ fileName: file.name, progress: 50, status: 'Queued for extraction...', docId: data.docId });
      this.pollExtractionStatus(data.docId);
    } catch (err: any) {
      this.activeIngestion.set({ fileName: file.name, progress: 100, status: `Error: ${err.message}` });
    }
  }

  pollExtractionStatus(docId: string) {
    const basePath = this.config.API_PATH || '/api';
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${basePath}/documents/${docId}`, {
          headers: { 'X-Api-Key': 'eagle-demi-api-key' }
        });
        if (!res.ok) return;
        const doc = await res.json();

        const cur = this.activeIngestion();
        let currentProg = cur ? cur.progress : 50;
        if (currentProg < 95) currentProg += 5;

        if (doc.contentExtracted) {
          clearInterval(interval);
          this.activeIngestion.set({ fileName: doc.displayName, progress: 100, status: 'Extraction complete!' });
          this.loadData();
        } else if (doc.contentExtractionError) {
          clearInterval(interval);
          this.activeIngestion.set({ fileName: doc.displayName, progress: 100, status: `Extraction failed: ${doc.contentExtractionError}` });
        } else {
          this.activeIngestion.set({ fileName: doc.displayName, progress: currentProg, status: 'Extracting text layout with Docling...' });
        }
      } catch {
        // Keep polling
      }
    }, 2500);
  }

  // Geospatial coordinate validation and healing helper
  parseCentroid(centroidData: any): [number, number] {
    if (!centroidData) return [-125.0, 54.0];

    let coords: number[] = [];
    if (Array.isArray(centroidData) && centroidData.length === 2) {
      coords = [Number(centroidData[0]), Number(centroidData[1])];
    } else if (typeof centroidData === 'object') {
      const c = centroidData.coordinates || centroidData.coords || [];
      if (Array.isArray(c) && c.length === 2) {
        coords = [Number(c[0]), Number(c[1])];
      }
    }

    if (coords.length !== 2 || isNaN(coords[0]) || isNaN(coords[1])) {
      return [-125.0, 54.0];
    }

    // 1. Swap if [lat, lng] instead of [lng, lat]
    if (coords[0] > 40 && coords[0] < 65 && coords[1] < -110 && coords[1] > -140) {
      coords = [coords[1], coords[0]];
    }
    // 2. Fix positive longitude signs (e.g. 120 -> -120)
    if (coords[0] > 110 && coords[0] < 140) {
      coords[0] = -coords[0];
    }
    // 3. Fix swapped positive coords (e.g. [53.354, 45.861] -> Sparwood is -114.8, 49.7)
    if (coords[0] > 40 && coords[0] < 60 && coords[1] > 110 && coords[1] < 140) {
      coords = [-coords[1], coords[0]];
    }

    // 4. Validate if within BC bounds, else fallback to BC center [-125.0, 54.0]
    if (coords[0] < -140 || coords[0] > -110 || coords[1] < 45 || coords[1] > 61) {
      return [-125.0, 54.0];
    }

    return [coords[0], coords[1]];
  }

  // Fallbacks helpers
  private generateFallbackDescription(p: any, rawMetadata: any): string {
    let desc = p.description || rawMetadata.trackAttributes?.description || '';
    if (desc && desc !== 'No project description provided.' && desc !== 'No project description provided') {
      return desc;
    }

    const matchedMock = this.mockProjects.find(mp => mp.name === p.name || mp.legacyEagleId === p._id);
    if (matchedMock && matchedMock.description) {
      return matchedMock.description;
    }

    const sector = p.sector || rawMetadata.trackAttributes?.type_name || 'Resource/Industrial';
    const region = p.region || 'British Columbia';
    const name = p.name || 'Unnamed Project';

    if (name.toLowerCase().includes('solar') || name.toLowerCase().includes('wind') || name.toLowerCase().includes('energy')) {
      return `${name} is a state-of-the-art clean energy and sustainability development in the ${region} region, designed to optimize local power grids and reduce carbon footprints.`;
    } else if (name.toLowerCase().includes('mine') || name.toLowerCase().includes('gold') || name.toLowerCase().includes('coal') || name.toLowerCase().includes('copper')) {
      return `${name} is a comprehensive mineral resource recovery project in the ${region} region, focused on sustainable extraction, robust environmental monitoring, and local economic growth.`;
    } else if (name.toLowerCase().includes('pipeline') || name.toLowerCase().includes('gas') || name.toLowerCase().includes('transmission')) {
      return `${name} represents a key infrastructure and transmission initiative located in the ${region} region, ensuring secure resource transportation under rigorous compliance and environmental reviews.`;
    } else {
      return `${name} is a major proposed ${sector.toLowerCase()} development located in the scenic ${region} region, currently progressing through the environmental assessment and public consultation review phase.`;
    }
  }

  private generateFallbackProponent(p: any, rawMetadata: any): string {
    const propName = p.proponent?.name || rawMetadata.trackAttributes?.proponent_name || '';
    if (propName && propName !== 'Proponent Organization') {
      return propName;
    }

    const matchedMock = this.mockProjects.find(mp => mp.name === p.name || mp.legacyEagleId === p._id);
    return matchedMock?.proponent || 'Proponent Organization';
  }

  // Levenshtein and fuzzy match helpers
  levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length < b.length) {
      const tmp = a; a = b; b = tmp;
    }
    if (b.length === 0) return a.length;

    // Use a single typed array to bypass 2D nested array allocations and GC pauses
    const row = new Int32Array(b.length + 1);
    for (let i = 0; i <= b.length; i++) {
      row[i] = i;
    }

    for (let i = 1; i <= a.length; i++) {
      let prev = i;
      for (let j = 1; j <= b.length; j++) {
        const val = a.charAt(i - 1) === b.charAt(j - 1)
          ? row[j - 1]
          : Math.min(row[j - 1] + 1, prev + 1, row[j] + 1);
        row[j - 1] = prev;
        prev = val;
      }
      row[b.length] = prev;
    }
    return row[b.length];
  }

  fuzzyMatch(text: string, query: string): boolean {
    if (!text || !query) return false;
    const cleanText = text.toLowerCase();
    const cleanQuery = query.toLowerCase();
    if (cleanText.includes(cleanQuery)) return true;

    const queryTokens = cleanQuery.split(/\s+/).filter(t => t.length > 2);
    if (queryTokens.length === 0) return false;

    const textWords = cleanText.split(/[^a-z0-9]+/).filter(w => w.length > 2);

    return queryTokens.every(qToken => {
      return textWords.some(word => {
        if (word.startsWith(qToken)) return true;
        const maxDist = qToken.length >= 5 ? 2 : 1;
        // Optimization: bypass O(N*M) Levenshtein if lengths differ by more than maxDist
        if (Math.abs(word.length - qToken.length) > maxDist) return false;
        return this.levenshtein(word, qToken) <= maxDist;
      });
    });
  }

  // Ray-casting point-in-polygon containment check
  private isPointInPolygon(point: [number, number], polygon: number[][][]): boolean {
    const [lng, lat] = point;
    if (!polygon || polygon.length === 0) return false;
    const outerRing = polygon[0];
    if (!outerRing || outerRing.length === 0) return false;

    let inside = false;
    for (let i = 0, j = outerRing.length - 1; i < outerRing.length; j = i++) {
      const xi = outerRing[i][0], yi = outerRing[i][1];
      const xj = outerRing[j][0], yj = outerRing[j][1];

      const intersect = ((yi > lat) !== (yj > lat))
        && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  private isPointInMultiPolygon(point: [number, number], multipolygon: number[][][][]): boolean {
    if (!multipolygon) return false;
    for (const polygon of multipolygon) {
      if (this.isPointInPolygon(point, polygon)) {
        return true;
      }
    }
    return false;
  }

  private isProjectInRegion(p: Project, regionName: string): boolean {
    const geo = this.regionalBoundariesGeoJSON();
    if (!geo || !p.centroid) return true;
    
    const feature = geo.features.find((f: any) => 
      (f.properties?.regionName || '').toLowerCase() === regionName.toLowerCase()
    );
    if (!feature || !feature.geometry) return true;

    const geom = feature.geometry;
    const point: [number, number] = [Number(p.centroid[0]), Number(p.centroid[1])];

    if (geom.type === 'Polygon') {
      return this.isPointInPolygon(point, geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      return this.isPointInMultiPolygon(point, geom.coordinates);
    }

    return true;
  }

  isProjectInBoundary(p: Project, bLayer: string, boundaryName: string): boolean {
    if (!bLayer || bLayer === 'none' || bLayer === 'regions' || !boundaryName || boundaryName === 'all' || !p.centroid) return true;

    const cache = this.loadedBoundariesGeoJSON();
    const boundaries = cache[bLayer];
    if (!boundaries || !Array.isArray(boundaries)) return true;

    const boundary = boundaries.find((b: any) => (b.name || '').toLowerCase() === boundaryName.toLowerCase());
    if (!boundary || (!boundary.geometry && !boundary.simplifiedGeometry)) return true;

    const geom = boundary.geometry || boundary.simplifiedGeometry;
    const point: [number, number] = [Number(p.centroid[0]), Number(p.centroid[1])];

    if (geom.type === 'Polygon') {
      return this.isPointInPolygon(point, geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      return this.isPointInMultiPolygon(point, geom.coordinates);
    }

    return true;
  }

  highlightText(text: string, query: string): string {
    if (!text) return '';
    
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

  logout() {
    sessionStorage.removeItem('isLoggedIn');
    localStorage.removeItem('isLoggedIn');
    if (this.keycloak) {
      const idToken = this.keycloak.idToken;
      const clientId = this.config.KEYCLOAK_CLIENT_ID || 'eagle-admin-console';
      const redirectUri = window.location.origin;

      this.keycloak.clearToken();

      let logoutUrl = `${this.config.KEYCLOAK_URL}/realms/${this.config.KEYCLOAK_REALM}/protocol/openid-connect/logout`;
      
      if (idToken) {
        logoutUrl += `?id_token_hint=${idToken}&post_logout_redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${encodeURIComponent(clientId)}`;
      } else {
        logoutUrl += `?redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${encodeURIComponent(clientId)}`;
      }

      window.location.href = logoutUrl;
    }
  }
}
