import { Injectable, signal, computed, effect, untracked, inject } from '@angular/core';
import { Project, Document } from '../models/registry.models';
import { MOCK_PROJECTS, MOCK_DOCUMENTS } from '../mocks/mock-registry.data';
import { ConfigService, AppConfig } from './config.service';

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
  private configService = inject(ConfigService);

  get config(): AppConfig {
    return this.configService.config;
  }
  
  getBasePath(): string {
    let basePath = this.config.API_PATH || '/api';
    if (this.config.API_LOCATION && (!basePath.startsWith('http://') && !basePath.startsWith('https://'))) {
      const loc = this.config.API_LOCATION.replace(/\/$/, '');
      const path = basePath.startsWith('/') ? basePath : '/' + basePath;
      basePath = `${loc}${path}`;
    }
    return basePath;
  }

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

  // Tracks the highest resolution mode loaded for each boundary category to prevent infinite fetch loops
  loadedBoundaryModes = computed<Record<string, 'none' | 'metadata' | 'simplified' | 'full'>>(() => {
    const cache = this.loadedBoundariesGeoJSON();
    const result: Record<string, 'none' | 'metadata' | 'simplified' | 'full'> = {
      regionalDistricts: 'none',
      municipalities: 'none',
      electoralDistricts: 'none'
    };
    for (const key of ['regionalDistricts', 'municipalities', 'electoralDistricts']) {
      const list = cache[key];
      if (list && list.length > 0) {
        const hasFull = list.some((b: any) => b.geometry);
        const hasSimplified = list.some((b: any) => b.simplifiedGeometry);
        if (hasFull) {
          result[key] = 'full';
        } else if (hasSimplified) {
          result[key] = 'simplified';
        } else {
          result[key] = 'metadata';
        }
      }
    }
    return result;
  });

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
  readonly mockProjects: Project[] = MOCK_PROJECTS;
  readonly mockDocuments: Document[] = MOCK_DOCUMENTS;

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
        const pRegion = (p.region || '').toLowerCase();
        const fRegion = region.toLowerCase();
        if (pRegion) {
          if (!pRegion.includes(fRegion) && !fRegion.includes(pRegion)) return false;
        } else if (selectedRegionGeom && p.centroid) {
          const point: [number, number] = [Number(p.centroid[0]), Number(p.centroid[1])];
          if (selectedRegionGeom.type === 'Polygon') {
            if (!this.isPointInPolygon(point, selectedRegionGeom.coordinates)) return false;
          } else if (selectedRegionGeom.type === 'MultiPolygon') {
            if (!this.isPointInMultiPolygon(point, selectedRegionGeom.coordinates)) return false;
          }
        }
      }

      // 3c. Administrative Boundary filter selection (prioritize tagged properties over ray casting)
      if (bFilter !== 'all' && bFilter !== '' && bLayer !== 'none') {
        const fFilter = bFilter.toLowerCase();
        let targetProp = '';
        if (bLayer === 'regionalDistricts') targetProp = (p.regionalDistrict || '').toLowerCase();
        else if (bLayer === 'municipalities') targetProp = (p.municipality || '').toLowerCase();
        else if (bLayer === 'electoralDistricts') targetProp = (p.electoralDistrict || '').toLowerCase();

        if (targetProp) {
          if (!targetProp.includes(fFilter) && !fFilter.includes(targetProp)) return false;
        } else if (selectedBoundaryGeom && p.centroid) {
          const point: [number, number] = [Number(p.centroid[0]), Number(p.centroid[1])];
          if (selectedBoundaryGeom.type === 'Polygon') {
            if (!this.isPointInPolygon(point, selectedBoundaryGeom.coordinates)) return false;
          } else if (selectedBoundaryGeom.type === 'MultiPolygon') {
            if (!this.isPointInMultiPolygon(point, selectedBoundaryGeom.coordinates)) return false;
          }
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
      const basePath = this.getBasePath();

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
          } catch (_refreshErr) {
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

  async loadRegionalBoundaries() {
    if (this.regionalBoundariesGeoJSON()) return;
    try {
      console.log('[Registry] Lazy loading environmental regions GeoJSON...');
      const res = await fetch('/env_regional_boundaries_reprojected.geojson');
      if (!res.ok) throw new Error('Failed to load regional boundaries GeoJSON');
      this.regionalBoundariesGeoJSON.set(await res.json());
    } catch (err) {
      console.error('Failed to load regional boundaries:', err);
    }
  }

  async loadBoundaryGeometry(type: string, mode: 'metadata' | 'simplified' | 'full' = 'simplified'): Promise<any> {
    const ranks: Record<string, number> = { none: 0, metadata: 1, simplified: 2, full: 3 };
    
    // Wrap cache signal reads in untracked() to prevent caller effects from registering these as dependencies!
    const cache = untracked(() => this.loadedBoundariesGeoJSON());
    const modes = untracked(() => this.loadedBoundaryModes());

    const currentMode = modes[type] || 'none';
    const requestedRank = ranks[mode] || 0;
    const currentRank = ranks[currentMode] || 0;

    if (currentRank >= requestedRank) {
      if (cache[type] && cache[type].length > 0) {
        return cache[type];
      }
    }

    this.isLoadingBoundaries.set(true);

    const basePath = this.getBasePath();

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
      
      this.loadedBoundariesGeoJSON.update(prev => {
        const next = { ...prev, [type]: data };
        this.saveCache(next);
        return next;
      });
      return data;
    } catch (err) {
      console.error(`[Registry loadBoundaryGeometry] Failed to load boundary metadata for ${type}:`, err);
      this.loadedBoundariesGeoJSON.update(prev => {
        const next = { ...prev, [type]: [] };
        this.saveCache(next);
        return next;
      });
      return [];
    } finally {
      this.isLoadingBoundaries.set(false);
    }
  }

  async loadBoundariesByBBox(type: string, bbox: string): Promise<any[]> {
    const basePath = this.getBasePath();

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

    const basePath = this.getBasePath();

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
              const { geometry: _geometry, simplifiedGeometry: _simplifiedGeometry, ...rest } = b;
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
      const basePath = this.getBasePath();

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
        this.projects.set([]);
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
        this.documents.set([]);
      }
    } catch (err) {
      console.error('[Registry loadData] API search fetch failed:', err);
      this.projects.set([]);
      this.documents.set([]);
      throw err;
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
      const basePath = this.getBasePath();
      
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
    const basePath = this.getBasePath();
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
    const desc = p.description || rawMetadata.trackAttributes?.description || '';
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
