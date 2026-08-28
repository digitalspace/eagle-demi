import { Injectable, signal, computed, effect, untracked, inject, WritableSignal } from '@angular/core';
import { Project, Document, DocumentChunk, SummaryCitation } from '../models/registry.models';
import { MOCK_PROJECTS, MOCK_DOCUMENTS } from '../mocks/mock-registry.data';
import { ConfigService, AppConfig } from './config.service';
import Keycloak from 'keycloak-js';

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

/** Boundary layer id -> the denormalised project field naming that boundary. */
const BOUNDARY_PROPS = {
  regionalDistricts: 'regionalDistrict',
  municipalities: 'municipality',
  electoralDistricts: 'electoralDistrict'
} as const;

/** One filter section resolved to the project field it names plus the polygons it selected. */
interface GeoSelection {
  prop: 'region' | 'regionalDistrict' | 'municipality' | 'electoralDistrict';
  /** Lower-cased selected names. OR'd: matching any one of them passes the section. */
  names: string[];
  geoms: any[];
}

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

  // Resolves once initKeycloak() has settled, so route guards can wait for the real auth state
  private resolveAuthReady!: () => void;
  readonly authReady: Promise<void> = new Promise<void>(resolve => (this.resolveAuthReady = resolve));

  isAuthenticated = signal<boolean>(false);
  isUnauthorized = signal<boolean>(false);
  userName = signal<string>('');

  // Visibility level from `GET /api/me`: 0 most privileged, 4 anonymous. Defaults to 4 so nothing
  // renders privileged UI while the request is in flight.
  visLevel = signal<number>(4);

  // Budget for `GET /api/me`. Static so a spec can shorten it before the constructor fires.
  static meTimeoutMs = 5000;

  /**
   * THE one answer to "may this person see staff-only things".
   *
   * There used to be a second notion — a `currentRole` signal flipped by a "EPIC Staff View /
   * Public Citizen View" toggle in the header — and the two drifted apart in both directions: a
   * signed-in staffer could sit in "public" while holding the privileged dataset in memory, and
   * with Keycloak disabled the toggle handed out the full admin UI with no credentials at all.
   * Worse, that toggle was the app's ONLY route to a login. It is gone. Authentication is the
   * state: to see the public site, log out.
   *
   * Derived, never assigned — nothing can set this out of step with the token it comes from.
   *
   * Keycloak off is a local-dev configuration, not a permission. The UI opens so the app is
   * workable offline; the API still returns the public corpus, because there is no token to send.
   */
  isStaff = computed(() =>
    !this.authEnabled() ? true : this.isAuthenticated() && !this.isUnauthorized()
  );

  // AI summary of the current search — step 5 of the pipeline, see wiki ADR-006. Privileged-only,
  // so for an anonymous visitor this stays null and no request is ever issued.
  //
  // null carries two meanings and the template distinguishes them with summaryLoading: null while
  // loading is the shimmer, null after loading is "no panel". Same null-sentinel convention the
  // three result columns already use.
  summary = signal<string | null>(null);
  summaryCitations = signal<SummaryCitation[]>([]);
  summaryLoading = signal<boolean>(false);
  summaryReason = signal<string | null>(null);

  /**
   * What the last answer cost, in CAD, and the token counts behind it.
   *
   * An ESTIMATE the API derives from reported usage and configured list rates — the page must label
   * it as one. It exists because this is the first per-token line in a project already running
   * ~2x its budget: a number on screen is how a query that costs fifty times the others gets
   * noticed the same day rather than on the invoice.
   */
  summaryCostCad = signal<number | null>(null);
  summaryUsage = signal<{ prompt_tokens?: number; completion_tokens?: number } | null>(null);

  /**
   * The summariser's question — deliberately NOT `searchQuery`.
   *
   * Search state on this service is global: `searchQuery` and every result signal are shared by
   * deep-search and map-explorer, and nothing clears them on navigation. A separate signal is what
   * stops typing on one page from silently rewriting the other, and it means `loadSummary()` can
   * run without disturbing a single result column.
   */
  summaryQuery = signal<string>('');

  // UI Interactive States (using Signals)
  activeTab = signal<'projects' | 'documents'>('projects');
  searchQuery = signal<string>('');
  debouncedSearchQuery = signal<string>('');
  // Every filter is multi-select: values inside one signal are OR'd, the signals AND together.
  // Empty means "no constraint" — there is no 'all' sentinel.
  gatingFilter = signal<Set<string>>(new Set());
  sectorFilter = signal<Set<string>>(new Set());
  regionFilter = signal<Set<string>>(new Set());
  // NOTE for whoever adds a document or project list to the summariser page: the two big computeds
  // branch on this. `filteredProjects`/`filteredDocuments` return [] only when this is 'search'
  // (:281, :313), and documents are constrained to map-matched projects whenever it is NOT
  // 'search' (:322). 'summary' therefore takes the second path. Inert today — that page reads
  // neither computed — but it is a trap, not a default.
  activePage = signal<'map' | 'search' | 'intake' | 'summary'>('map');

  intakeProjectId = signal<string>('');
  intakeProjectSearchQuery = signal<string>('');
  showIntakeDropdown = signal<boolean>(false);
  activeIngestion = signal<{ fileName: string, progress: number, status: string, docId?: string } | null>(null);

  // Datasets (using Signals - null representing loading sentinel)
  projects = signal<Project[] | null>(null);
  documents = signal<Document[] | null>(null);
  // Matches inside extracted document TEXT — this is what makes Deep Search "deep" rather than
  // a metadata search. Populated only when there is a query; null is the loading sentinel.
  documentChunks = signal<DocumentChunk[] | null>(null);

  // True while loadData() is in flight. The lists are no longer blanked on a re-search, so this is
  // what tells a screen to dim the rows it already has instead of flashing placeholders at them.
  searching = signal<boolean>(false);

  /** 'first' — nothing to show yet, render skeletons. 'refresh' — keep the old rows, dim them. */
  private loadPhase(list: unknown[] | null): 'first' | 'refresh' | null {
    if (list === null) return 'first';
    return this.searching() ? 'refresh' : null;
  }

  projectsLoading = computed(() => this.loadPhase(this.filteredProjects()));
  documentsLoading = computed(() => this.loadPhase(this.filteredDocuments()));
  chunksLoading = computed(() => this.loadPhase(this.documentChunks()));

  // Selected Items (using Signals)
  selectedProject = signal<Project | null>(null);
  selectedDocument = signal<Document | null>(null);

  // Map viewport states
  mapInViewProjectIds = signal<(string | number)[]>([]);

  // Boundaries GeoJSON cache
  regionalBoundariesGeoJSON = signal<any>(null);

  // Active administrative boundary layer categories on the map (multiple allowed!)
  activeBoundaryLayers = signal<string[]>(['regions']);

  // Active administrative boundary layer category on the map
  activeBoundaryLayer = computed<'none' | 'regions' | 'regionalDistricts' | 'municipalities' | 'electoralDistricts'>(() => {
    const layers = this.activeBoundaryLayers();
    if (layers.length === 0) return 'none';
    return layers[layers.length - 1] as any;
  });

  // Selected boundary names per layer. The layers are independent, so a project can be constrained
  // by a regional district AND a municipality at once.
  boundaryFilter = signal<Record<string, Set<string>>>({});

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

  // Non-null when the last loadData() failed. The UI must show this rather than an
  // innocent-looking empty list — an outage should never be mistaken for "no results".
  loadError = signal<string | null>(null);

  // Index-wide match totals from the API, NOT the number of rows rendered. There is no paging, so
  // a column showing `results.length` is really showing pageSize and reads as "that is all there
  // is". Null when the backend did not report one — the keywordless Cosmos list path has no total.
  projectMatchCount = signal<number | null>(null);
  documentMatchCount = signal<number | null>(null);
  chunkMatchCount = signal<number | null>(null);

  // Cancels the in-flight search when a newer one starts. Without this the last request to
  // RESOLVE wins each signal rather than the last one issued, and fetchWithRetry's backoff sleeps
  // make that window seconds wide — so a stale response can overwrite a fresh one.
  private loadedQuery: string | null = null;
  private searchAbort: AbortController | null = null;

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

  /**
   * Everything the per-project predicate needs that is resolved ONCE, not per row.
   *
   * The geometry lookups are the reason this exists separately: finding the selected region or
   * boundary polygons inside the filter callback would repeat a `find()` over every boundary for
   * every project.
   */
  private projectFilterContext() {
    return {
      gating: this.gatingFilter(),
      sector: this.sectorFilter(),
      staff: this.isStaff(),
      geo: this.geoSelections()
    };
  }

  /**
   * The region section and the three boundary sections, each resolved to the project field it
   * names plus the polygons of every value ticked in it. One entry per section: the caller ANDs
   * across the entries while the names inside one entry are OR'd.
   */
  private geoSelections(): GeoSelection[] {
    const out: GeoSelection[] = [];
    // A geometry of any other type cannot be ray cast, so dropping it here keeps `geoms.length`
    // meaning "there is something to test against".
    const usable = (g: any) => g && (g.type === 'Polygon' || g.type === 'MultiPolygon');

    const regions = [...this.regionFilter()].map(r => r.toLowerCase());
    if (regions.length) {
      // Shape-checked, not just truthy: a boundary answer that is not a FeatureCollection would
      // otherwise throw out of the computed and blank the project list.
      const features: any[] = this.regionalBoundariesGeoJSON()?.features || [];
      out.push({
        prop: 'region',
        names: regions,
        geoms: features
          .filter(f => regions.includes((f.properties?.regionName || '').toLowerCase()))
          .map(f => f.geometry)
          .filter(usable)
      });
    }

    const selected = this.boundaryFilter();
    const cache = this.loadedBoundariesGeoJSON();
    for (const [layer, prop] of Object.entries(BOUNDARY_PROPS)) {
      const names = [...(selected[layer] || [])].map(n => n.toLowerCase());
      if (!names.length) continue;
      const boundaries: any[] = cache[layer] || [];
      out.push({
        prop,
        names,
        geoms: boundaries
          .filter(b => names.includes((b.name || '').toLowerCase()))
          .map(b => b.geometry || b.simplifiedGeometry)
          .filter(usable)
      });
    }

    return out;
  }

  /** Does the project fall inside any one value ticked in this section? */
  private matchesGeoSelection(p: Project, sel: GeoSelection): boolean {
    // The denormalised field wins when the record carries one; ray casting the centroid is the
    // fallback for rows that were never tagged.
    const value = String(p[sel.prop] || '').toLowerCase();
    if (value) return sel.names.some(n => value.includes(n) || n.includes(value));
    if (!p.centroid || !sel.geoms.length) return true;
    return sel.geoms.some(g => this.containsPoint(g, p.centroid!));
  }

  private containsPoint(geom: any, centroid: (string | number)[]): boolean {
    const point: [number, number] = [Number(centroid[0]), Number(centroid[1])];
    return geom.type === 'Polygon'
      ? this.isPointInPolygon(point, geom.coordinates)
      : this.isPointInMultiPolygon(point, geom.coordinates);
  }

  /**
   * Does one project survive the active filters?
   *
   * Shared by `filteredProjectsNoQuery` and `sectorOptions` deliberately. The counts on the sector
   * chips have to be produced by the SAME predicate the chip then applies, or a chip promises rows
   * that clicking it cannot deliver. `skipSector` is what lets the counts answer "how many would
   * this chip give me", which is a question about every filter EXCEPT sector.
   */
  private matchesProjectFilters(p: Project, ctx: ReturnType<RegistryStateService['projectFilterContext']>, skipSector = false): boolean {
    // 1. Role access gating
    if (!ctx.staff && p.gatingState !== 'admitted') return false;

    // 2. Gating filter selection
    if (ctx.gating.size && !ctx.gating.has(p.gatingState || '')) return false;

    // 3. Sector: exact match on the trimmed value, because the chips are built FROM these values
    // (see `sectorOptions`). Substring matching missed `Coal Mines` and `Power Plants` outright.
    if (!skipSector && ctx.sector.size && !ctx.sector.has((p.sector || '').trim())) return false;

    // 4. Region and administrative boundaries: OR within a section, AND across them.
    return ctx.geo.every(sel => this.matchesGeoSelection(p, sel));
  }

  // Projects matching active filters (excluding query)
  filteredProjectsNoQuery = computed(() => {
    const projs = this.projects();
    if (projs === null) return null;

    const ctx = this.projectFilterContext();
    return projs.filter(p => this.matchesProjectFilters(p, ctx));
  });

  /**
   * The sector chips: every sector present in the data, with the count each one would return.
   *
   * Built from the loaded projects rather than an AI Search `facets` parameter. At 382 projects
   * against the `pageSize=500` the loader already asks for, the browser holds the whole corpus, so
   * a client-side count is complete AND is produced by the same predicate the chip applies — a
   * server facet could not promise the second, because the neighbouring region filter is geometric
   * (`isPointInPolygon`) rather than a field equality Azure could count.
   *
   * CEILING: honest only while the loaded page IS the corpus. Past `pageSize` these silently become
   * counts of a page. The answer then is paging or a server-side facet, not a bigger number in the
   * URL — the API caps list reads at 1000 whatever is asked.
   *
   * Values are trimmed before grouping. The live data carries whitespace twins —
   * `Groundwater Extraction` ×9 alongside `Groundwater Extraction ` ×9, and the same for
   * `Shoreline Modification` and `Water Diversion` — which would otherwise show as two chips
   * splitting one sector's count.
   */
  sectorOptions = computed<{ value: string; label: string; count: number }[]>(() => {
    const projs = this.projects();
    if (projs === null) return [];

    const ctx = this.projectFilterContext();
    const counts = new Map<string, number>();

    for (const p of projs) {
      if (!this.matchesProjectFilters(p, ctx, true)) continue;
      const value = (p.sector || '').trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }

    // A selected sector always keeps a chip, even at zero. The list is counted under the OTHER
    // active filters, so narrowing the region can empty a sector the user picked — and without
    // this its chip would simply vanish, leaving a map with no projects, no chip rendered active,
    // and nothing to click to get back. A `(0)` chip says "this is still your filter, and it now
    // matches nothing", which is the true statement.
    for (const selected of this.sectorFilter()) {
      if (!counts.has(selected)) counts.set(selected, 0);
    }

    return [...counts.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  });

  // Dynamic Filtering Computations (Signals are automatically tracked!)
  filteredProjects = computed(() => {
    const query = this.debouncedSearchQuery().toLowerCase().trim();

    const projs = this.filteredProjectsNoQuery();
    if (projs === null) return null;

    if (!query) return projs;

    console.log('[Registry filteredProjects] Starting query filter of projects count:', projs.length, { query });

    const result = projs.filter(p => {
      const propName = typeof p.proponent === 'string' ? p.proponent : ((p.proponent as any)?.name || '');
      const trackDesc = p.rawMetadata?.trackAttributes?.description || '';
      const textToSearch = `${p.name || ''} ${p.sector || ''} ${p.status || ''} ${p.region || ''} ${p.gatingState || ''} ${p.description || ''} ${trackDesc} ${propName}`;
      return this.fuzzyMatch(textToSearch, query);
    });

    console.log('[Registry filteredProjects] Filtered projects result count:', result.length);
    return result;
  });

  filteredDocuments = computed(() => {
    const query = this.debouncedSearchQuery().toLowerCase().trim();
    const gating = this.gatingFilter();
    const staff = this.isStaff();
    
    // Track active filtered projects to align document list with active map/region filters!
    const projs = this.filteredProjectsNoQuery() || [];
    const matchedProjectIds = new Set(projs.map(p => p.id));

    const docs = this.documents();
    if (docs === null) return null;

    return docs.filter(d => {
      // Unify filtering: only show documents belonging to projects that match our current filters (sector, region, etc.)
      if (this.activePage() !== 'search' && !matchedProjectIds.has(d.projectId)) return false;

      // 1. Role access gating
      if (!staff && d.gatingState !== 'admitted') return false;

      // 2. Gating filter selection
      if (gating.size && !gating.has(d.gatingState || '')) return false;

      // 3. Concatenate search text fields to bypass JSON stringify and speed up search
      if (query) {
        const textToSearch = `${d.displayName || ''} ${d.documentFileName || ''} ${d.documentType || ''} ${d.projectName || ''} ${d.orcsCode || ''} ${d.gatingState || ''} ${d.textSnippet || ''} ${(d as any).description || ''}`;
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

    // Re-fetch whenever auth state changes. The API returns a different dataset to an
    // authenticated admin than to the public, so reusing rows fetched under the previous
    // credentials would leave stale (or over-privileged) data on screen after login/logout.
    let lastAuthState: boolean | null = null;
    effect(() => {
      const authed = this.isAuthenticated();
      if (lastAuthState === null) {
        lastAuthState = authed;   // initial load is already handled by authSettled()
        return;
      }
      if (lastAuthState !== authed) {
        lastAuthState = authed;
        this.loadData();
      }
    }, { allowSignalWrites: true });
  }

  // Auto-retry helper for resilient API requests on intermittent 5xx or network errors
  private async fetchWithRetry(url: string, options?: RequestInit, retries = 2, delayMs = 1000): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, options);
        if (res.ok) return res;
        if (attempt < retries && (res.status >= 500 || res.status === 429)) {
          console.warn(`[FetchRetry] HTTP ${res.status} for ${url}. Retrying attempt ${attempt + 1}/${retries}...`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        return res;
      } catch (err) {
        // A cancelled request is not a failure. Retrying it would resurrect a search the user has
        // already moved past AND spend two 1s sleeps doing it, which is the opposite of what the
        // abort was for.
        if (this.isAbortError(err)) throw err;
        if (attempt < retries) {
          console.warn(`[FetchRetry] Network error for ${url}. Retrying attempt ${attempt + 1}/${retries}...`, err);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        throw err;
      }
    }
    return fetch(url, options);
  }

  /** Cancellation, however the platform spells it. Safari uses a plain Error with this name. */
  private isAbortError(err: unknown): boolean {
    return Boolean(err) && (err as { name?: string }).name === 'AbortError';
  }

  /**
   * Is this URL our own API?
   *
   * Compares origin + path prefix rather than doing `url.includes(basePath)`. That
   * substring test was a credential-leak primitive: getBasePath() falls back to '/api',
   * and `includes('/api')` matches ANY url containing those characters — including
   * third-party hosts — which would attach the user's Bearer token to them.
   */
  private isApiUrl(url: string): boolean {
    try {
      const base = new URL(this.getBasePath(), window.location.origin);
      const target = new URL(url, window.location.origin);
      if (target.origin !== base.origin) return false;
      const basePathname = base.pathname.replace(/\/$/, '');
      return target.pathname === basePathname || target.pathname.startsWith(basePathname + '/');
    } catch {
      return false;
    }
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
      const isApiRequest = this.isApiUrl(url);

      if (isApiRequest && this.keycloak && this.keycloak.token) {
        init = init || {};
        setAuthHeader(init, this.keycloak.token);
      }

      try {
        let response = await originalFetch(input, init);

        // Only refresh/retry for OUR api. A third-party 401 (e.g. the DataBC WFS layer)
        // must never trigger a token refresh, let alone a replay carrying a fresh token.
        if (isApiRequest && (response.status === 401 || response.status === 403) && this.keycloak) {
          if (!refreshPromise) {
            refreshPromise = this.keycloak.updateToken(30)
              .then((refreshed: any) => {
                refreshPromise = null;
                return refreshed;
              })
              .catch((err: any) => {
                refreshPromise = null;
                console.warn('[Fetch Interceptor] Keycloak token refresh failed:', err);
                // The session is over. Say so, rather than leaving `isAuthenticated` true forever —
                // nothing else in the app ever set it back to false, so an expired token used to
                // leave the header claiming a live session and `isStaff()` granting staff UI over
                // data the API had already started refusing.
                this.isAuthenticated.set(false);
                this.userName.set('');
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

  // Resolve the authReady gate and kick off the initial data load exactly once
  private async authSettled() {
    const resolve = this.resolveAuthReady;
    if (!resolve) return;
    this.resolveAuthReady = null as any;
    // The bearer token is already attached by now, so the corpus load does not need to wait
    // for /me; only the gate does.
    this.loadData();
    await this.loadVisLevel();
    resolve();
  }

  /** Ask the API what this caller may see; fall back to the token roles when it cannot answer. */
  private async loadVisLevel(): Promise<void> {
    let privileged: boolean | null = null;
    try {
      const res = await fetch(`${this.getBasePath()}/me`, {
        signal: AbortSignal.timeout(RegistryStateService.meTimeoutMs)
      });
      if (res.ok) {
        const me = await res.json();
        if (typeof me?.level === 'number') this.visLevel.set(me.level);
        // Read the server's answer; never re-derive it from `tier`. A staff credential scoped to
        // one project reports tier `scoped`, so a `tier === 'privileged'` test called that staffer
        // unauthorized.
        if (typeof me?.privileged === 'boolean') privileged = me.privileged;
      }
    } catch (err) {
      console.warn('[Me] /api/me unavailable, falling back to token roles', err);
    }
    if (privileged === null) {
      // A hung or refusing /api/me must not lock a real staffer out for the session; redaction is
      // server-side either way, so the client keeps level 4 and only the UI gate falls back.
      const roles: string[] = this.keycloak?.tokenParsed?.realm_access?.roles || [];
      privileged = roles.includes('sysadmin') || roles.includes('staff') || roles.includes('demi-admin');
    }
    // Anonymous is the public tier too, so this stays conjoined with isAuthenticated — otherwise
    // every public visitor gets the "your account has no staff access" copy.
    this.isUnauthorized.set(this.isAuthenticated() && !privileged);
  }

  // Keycloak initialization Flow
  /** Refresh the access token before it expires so a 401 never starts the session-over path. */
  private keepTokenFresh() {
    const tick = () => this.keycloak?.updateToken(70).catch((err: unknown) => {
      console.warn('[Keycloak] token refresh failed; session over', err);
      this.clearAuthState();
    });
    setInterval(tick, 60_000);
  }

  private initKeycloak() {
    if (!this.authEnabled()) {
      this.authSettled();
      return;
    }

    try {
      // Path routing (see app.config.ts) never reads/writes location.hash, so Keycloak's
      // default fragment response mode is safe here — matches eagle-admin's pattern.
      const oauthParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.hash.replace(/^#/, '')) : new URLSearchParams();

      // If URL contains an OAuth error (like error=login_required), clean URL immediately and run in public mode
      if (oauthParams.has('error')) {
        console.warn('[Keycloak] OAuth error parameter detected in URL. Cleaning URL and running in public mode.');
        this.cleanUrlParams();
        sessionStorage.removeItem('isLoggedIn');
        localStorage.removeItem('isLoggedIn');
        this.isAuthenticated.set(false);
        this.authSettled();
        return;
      }

      this.keycloak = new Keycloak({
        url: this.config.KEYCLOAK_URL ?? '',
        realm: this.config.KEYCLOAK_REALM ?? '',
        clientId: this.config.KEYCLOAK_CLIENT_ID ?? ''
      });

      const cleanRedirectUri = typeof window !== 'undefined' ? (window.location.origin + window.location.pathname) : '';
      const isOAuthCallback = oauthParams.has('code');
      const previouslyLoggedIn = typeof sessionStorage !== 'undefined' && (sessionStorage.getItem('isLoggedIn') === 'true' || localStorage.getItem('isLoggedIn') === 'true');

      if (!isOAuthCallback && !previouslyLoggedIn) {
        console.log('[Keycloak] Public visitor detected; skipping SSO redirect and running in public mode.');
        this.isAuthenticated.set(false);
        this.authSettled();
        return;
      }

      // keycloak-js processes a valid callback code unconditionally, before even looking at
      // onLoad — but if that processing fails for any reason, onLoad is what decides what
      // happens next: 'check-sso' retries via the silent iframe below; omitting onLoad
      // (as a prior version of this code did) makes it give up silently with no error and no
      // retry, which reads as "kicked to public for no reason". Always keep onLoad set.
      // A remembered login uses 'login-required': a full redirect to the IdP, which holds a
      // first-party cookie and bounces straight back with a code, no prompt. 'check-sso' does
      // the same through a hidden iframe, which needs third-party cookies that browsers now
      // block by default, so a page reload silently signed the user out.
      const keycloakPromise = this.keycloak.init({
        onLoad: previouslyLoggedIn && !isOAuthCallback ? 'login-required' : 'check-sso',
        checkLoginIframe: false,
        pkceMethod: 'S256',
        scope: 'openid roles',
        redirectUri: cleanRedirectUri,
        silentCheckSsoRedirectUri: typeof window !== 'undefined' ? (window.location.origin + '/silent-check-sso.html') : undefined
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Keycloak initialization timeout')), 15000)
      );

      Promise.race([keycloakPromise, timeoutPromise]).then((authenticated: any) => {
        this.cleanUrlParams();

        if (authenticated) {
          sessionStorage.setItem('isLoggedIn', 'true');
          localStorage.setItem('isLoggedIn', 'true');
          this.isAuthenticated.set(true);
          this.userName.set(this.keycloak.tokenParsed?.preferred_username || this.keycloak.tokenParsed?.name || 'Staff User');
          this.keepTokenFresh();
        } else {
          sessionStorage.removeItem('isLoggedIn');
          localStorage.removeItem('isLoggedIn');
          this.isAuthenticated.set(false);
        }
        // Load data only after keycloak status is resolved, so the Bearer token is attached
        this.authSettled();
      }).catch((err: any) => {
        console.warn('[Keycloak] Keycloak initialization skipped / offline mode fallback:', err);
        this.cleanUrlParams();
        sessionStorage.removeItem('isLoggedIn');
        localStorage.removeItem('isLoggedIn');
        this.isAuthenticated.set(false);
        this.authSettled();
      });
    } catch (err) {
      console.warn('[Keycloak] Keycloak client library unavailable:', err);
      this.authSettled();
    }
  }

  loginKeycloak() {
    if (!this.keycloak) {
      try {
        this.keycloak = new Keycloak({
          url: this.config.KEYCLOAK_URL ?? '',
          realm: this.config.KEYCLOAK_REALM ?? '',
          clientId: this.config.KEYCLOAK_CLIENT_ID ?? ''
        });
      } catch (e) {
        console.error('[Keycloak] Failed to create Keycloak client:', e);
        return;
      }
    }

    const redirectUri = window.location.origin + window.location.pathname;

    if (this.keycloak.authenticated !== undefined) {
      this.keycloak.login({ redirectUri });
    } else {
      this.keycloak.init({
        onLoad: 'login-required',
        checkLoginIframe: false,
        pkceMethod: 'S256',
        scope: 'openid roles',
        redirectUri
      }).catch((err: any) => {
        console.error('[Keycloak] Explicit login init failed:', err);
        this.cleanUrlParams();
      });
    }
  }

  // Strip Keycloak's OAuth response out of the hash. Path routing (app.config.ts) never
  // puts a route there, so the hash only ever holds OAuth junk — safe to drop entirely.
  private cleanUrlParams() {
    if (typeof window === 'undefined') return;
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
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

    // First attempt: Try loading static boundary GeoJSON asset from web storage
    let staticAsset = '';
    if (type === 'regionalDistricts') staticAsset = '/assets/geojson/regional_districts.geojson';
    else if (type === 'municipalities') staticAsset = '/assets/geojson/municipalities.geojson';
    else if (type === 'electoralDistricts') staticAsset = '/assets/geojson/electoral_districts.geojson';

    if (staticAsset) {
      try {
        const staticRes = await fetch(staticAsset);
        if (staticRes.ok) {
          const data = await staticRes.json();
          if (Array.isArray(data) && data.length > 0) {
            console.log(`[Registry loadBoundaryGeometry] Loaded static GeoJSON asset for ${type} (${data.length} items)`);
            this.loadedBoundariesGeoJSON.update(prev => {
              const next = { ...prev, [type]: data };
              this.saveCache(next);
              return next;
            });
            this.isLoadingBoundaries.set(false);
            return data;
          }
        }
      } catch (_assetErr) {
        // Fall back gracefully to backend API query below
      }
    }

    try {
      let geomParam = '';
      if (mode === 'full') {
        geomParam = '&geometry=true';
      } else if (mode === 'metadata') {
        geomParam = '&geometry=false';
      } else {
        geomParam = '&geometry=simplified';
      }
      
      const res = await this.fetchWithRetry(`${basePath}/boundaries?type=${encodeURIComponent(apiType)}${geomParam}`);
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
      const res = await fetch(`${basePath}/boundaries?type=${encodeURIComponent(apiType)}&bbox=${encodeURIComponent(bbox)}`);
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
      const res = await fetch(`${basePath}/boundaries/${encodeURIComponent(name)}`);
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


  /**
   * Column header count: "12", or "12 of 1,204" when the index matched more than is on screen.
   *
   * The bare length was misleading. There is no paging, so a full column showed pageSize and read
   * as "that is all there is" — and the client-side sector/region/gating filters cut it further,
   * below a total the user was never shown. Only widen to the two-part form when the numbers
   * actually differ; "12 of 12" is noise.
   */
  resultCountLabel(shown: number | null | undefined, total: number | null): string {
    // A null length is the loading sentinel, not an empty result. Pairing it with a stale total
    // would flash "0 of 1,204" between every keystroke.
    if (shown === null || shown === undefined) return '…';
    if (total === null || total <= shown) return String(shown);
    return `${shown} of ${total.toLocaleString()}`;
  }

  // Load datasets from Express api, falling back to rich mock data if empty/fails
  async loadData() {
    this.loadError.set(null);

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
      // No mock chunks: extracted text has no fixture, and [] reads as "none" rather than
      // hanging on the loading sentinel forever. The summary signals are NOT touched here —
      // `loadSummary()` owns them and has its own mock-mode branch.
      this.documentChunks.set([]);
      return;
    }

    // Every screen calls loadData() on entry. The corpus for a given query is already in memory
    // after the first load (two ~370 kB uncompressed responses at ~2 s each), so only a changed
    // query or an empty cache goes back to the API.
    const q = this.searchQuery();
    if (q === this.loadedQuery && this.projects() !== null && this.documents() !== null && !this.searching()) {
      return;
    }

    // Supersede whatever is still in flight. The three requests below are independent of each
    // other but NOT of the next keystroke — without this they race, and the loser can win.
    this.searchAbort?.abort();
    const abort = new AbortController();
    this.searchAbort = abort;
    const signal = abort.signal;
    this.searching.set(true);

    try {
      const basePath = this.getBasePath();

      console.log('[Registry] Loading real-time projects and documents from central dev database...');

      let projParams = `dataset=Project&pageSize=500`;
      if (q) projParams += `&keywords=${encodeURIComponent(q)}&fuzzy=true`;
      // Sector is NOT sent. The controller reads only dataset/keywords/fuzzy/pageSize, so the old
      // `and[sector]` param was decoration; the real filtering is client-side in
      // filteredProjectsNoQuery, whose prefix/substring matching an OData `eq` would not reproduce.

      console.log('[Registry loadData] Fetching projects from URL:', `${basePath}/search?${projParams}`);

      // Issued together, not in sequence. Nothing here depends on anything else here, and three
      // serial round trips cost the user three times the latency for no reason.
      const projPromise = this.fetchWithRetry(`${basePath}/search?${projParams}`, { signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`Projects API returned status ${res.status}`);
          return res.json();
        });

      let docParams = `dataset=Document&pageSize=500`;
      if (q) {
        docParams += `&keywords=${encodeURIComponent(q)}&fuzzy=true`;
      }

      const docPromise = this.fetchWithRetry(`${basePath}/search?${docParams}`, { signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`Documents API returned status ${res.status}`);
          return res.json();
        });

      // Full-text matches from inside the documents. Only meaningful with a query, and a failure
      // here must not take the whole page down — metadata results are still worth showing. That is
      // why this leg keeps its own catch instead of riding the shared one below.
      const chunkPromise = q
        ? this.fetchWithRetry(
          `${basePath}/search?dataset=DocumentChunk&pageSize=50&keywords=${encodeURIComponent(q)}&fuzzy=true`,
          { signal }
        )
          .then(async (res) => (res.ok ? res.json() : null))
          .catch((chunkErr) => {
            if (this.isAbortError(chunkErr)) throw chunkErr;
            console.warn('[Registry] Full-text chunk search failed:', chunkErr);
            return null;
          })
        : Promise.resolve(null);

      // NO summary leg here. The summariser lives on its own page with its own query and its own
      // fetch (`loadSummary`), so an ordinary keyword search costs three requests per debounce and
      // never a model call. It briefly rode along on this fan-out, gated on `isAuthenticated()`
      // alone — which meant an authenticated-but-unauthorized user fired a guaranteed 401 on every
      // keystroke, straight into the interceptor's refresh-and-replay.
      const [apiProjects, apiDocuments, apiChunks] = await Promise.all([
        projPromise, docPromise, chunkPromise
      ]);

      const resultsDoc = apiDocuments[0]?.searchResults || [];
      this.documentMatchCount.set(apiDocuments[0]?.count ?? null);

      if (apiChunks) {
        const resultsChunk = apiChunks[0]?.searchResults || [];
        this.chunkMatchCount.set(apiChunks[0]?.count ?? null);
        this.documentChunks.set(resultsChunk.map((c: any) => ({
          id: String(c._id),
          documentId: String(c.documentId || ''),
          // `project` is the {_id, name} pair eagle-public's row templates bind. The bare id it
          // used to be is still accepted so a rollback of the API needs no frontend deploy.
          // `projectId` is the DEMI id — the Cosmos partition key `fetchDocument`/`getDownloadUrl`
          // pass back, and the id-space `Project.id` holds. `project._id` is the EAGLE ObjectId
          // eagle-public's row templates route on, so it is NOT a source for this field; it is only
          // read as a rollback fallback, from before the API carried both.
          projectId: c.projectId || c.project?._id || c.project || '',
          projectName: c.projectName || 'Associated Project',
          documentName: c.documentName || 'Untitled Document',
          documentType: c.documentType || 'PDF Document',
          pageNumber: Number(c.pageNumber) || 0,
          content: c.content || '',
          snippet: c.snippet || ''
        })));
      } else {
        this.chunkMatchCount.set(null);
        this.documentChunks.set([]);
      }

      const resultsProj = apiProjects[0]?.searchResults || [];
      this.projectMatchCount.set(apiProjects[0]?.count ?? null);

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

          // Server markup only survives where the field it describes survives. Both `name` and
          // `description` can be replaced below by text of OUR invention, and marking a phrase
          // inside a sentence the user never searched — because we wrote it — is worse than not
          // marking at all. Where it is dropped, the renderer falls back to client marking.
          const name = p.name || 'Unnamed Project';
          const description = this.generateFallbackDescription(p, rawMetadata);
          const highlighted = {
            name: p.name ? (p.highlighted?.name || '') : '',
            description: description === p.description ? (p.highlighted?.description || '') : ''
          };

          return {
            _id: p._id,
            id: p.id || p.trackProjectId || p._id,
            trackProjectId: p.trackProjectId || p.id,
            legacyEagleId: p.legacyEagleId || p._id,
            name,
            highlighted,
            sector: (p.sector && p.sector !== 'Other') ? p.sector : (rawMetadata.type_name || rawMetadata.trackAttributes?.type_name || 'Other'),
            status: p.status || rawMetadata.trackAttributes?.project_state_name || 'Active',
            centroid: this.parseCentroid(p.centroid),
            gatingState: (p.isPublished === false) ? 'staged' : 'admitted',
            region: p.region || 'British Columbia',
            description,
            proponent: this.generateFallbackProponent(p, rawMetadata),
            rawMetadata: rawMetadata,
            sources: p.sources
          };
        });
        this.projects.set(mappedProjects);
      } else {
        this.projects.set([]);
      }

      if (Array.isArray(resultsDoc) && resultsDoc.length > 0) {
        const mappedDocs: Document[] = resultsDoc.map((d: any) => {
          // See the chunk mapping above. `projectId` is the DEMI id and is what the two consumers
          // of this field compare against `Project.id`: `filteredDocuments` (line 446) and
          // `map-explorer.getProjDocCount`. Taking it from `project._id` — which the envelope
          // change made an EAGLE ObjectId — compared across id-spaces and matched nothing, so the
          // per-project document counts read 0 and the document list emptied on every page but
          // /search. The fallbacks are for a rolled-back API only.
          const projId = d.projectId || d.project?._id || d.project || '';
          const matchedProj = (this.projects() || []).find(p => p.id === projId || p.legacyEagleId === projId);
          const resolvedProjectName = matchedProj ? matchedProj.name : (d.projectName || 'Associated Project');

          // Placeholder names stay as they are; a title rebuilt from "document.pdf" read "Document Document".
          const displayName = d.displayName || d.documentFileName || 'Untitled Document';
          const fileFileName = d.documentFileName || (d.s3Key ? d.s3Key.split('/').pop() : '');

          // Never invent a description. The API's own placeholder is dropped too, and the
          // subline falls back to real metadata: source, type, date posted.
          const placeholder = /^(Unnamed Document|Untitled Document|No project description provided|Official document extracted from central registry\.?)$/;
          let snippet = d.description || d.textSnippet || '';
          let snippetHtml = d.highlighted?.description || '';
          if (!snippet || placeholder.test(snippet)) {
            const posted = d.datePosted ? new Date(d.datePosted).toLocaleDateString('en-CA') : '';
            snippet = [d.documentSource, d.type !== 'None' ? d.type : '', posted].filter(Boolean).join(' · ');
            snippetHtml = '';
          }
          const displayNameHtml = d.highlighted?.displayName || '';

          return {
            id: d._id,
            displayName: displayName,
            documentFileName: fileFileName,
            documentType: d.documentType || 'Document',
            // Never invent a record number — this rendered the literal '34800-20/MOCK' to
            // users as "Record Number (ORCS)" for every document without a classification.
            orcsCode: d.orcsClassification || '',
            projectId: projId,
            projectName: resolvedProjectName,
            gatingState: (d.isPublished === false) ? 'staged' : 'admitted',
            textSnippet: snippet,
            highlighted: { displayName: displayNameHtml, textSnippet: snippetHtml }
          };
        });
        this.documents.set(mappedDocs);
      } else {
        this.documents.set([]);
      }

      this.loadedQuery = q;
      this.searching.set(false);
    } catch (err) {
      // A superseded search is not an outage. Leave every signal alone: a newer loadData() is
      // already running and owns them now, and clearing them here would blank the results the
      // user is about to see — or raise an error banner for a request we cancelled ourselves.
      if (this.isAbortError(err)) return;   // the newer loadData() owns `searching` now

      this.searching.set(false);

      // Do NOT silently substitute mock data here. Doing so made a broken backend render as
      // a healthy demo full of fictional projects, masking outages and every other bug.
      // Mocks are opt-in via USE_MOCK_DATA only; otherwise surface the failure.
      console.error('[Registry loadData] API search fetch failed:', err);
      this.projects.set([]);
      this.documents.set([]);
      this.projectMatchCount.set(null);
      this.documentMatchCount.set(null);
      this.chunkMatchCount.set(null);
      this.loadError.set(
        'Could not load registry data from the API. This is a connection or server error — ' +
        'the list below is empty, not filtered.'
      );
    }
  }

  // `setDemoRole` lived here. It was three branches: log in, flip a signal, or — for an
  // authenticated user missing the realm role — warn to the console and return, leaving a
  // clickable button that did nothing. Its login branch was also the app's only route to Keycloak,
  // which is why a view toggle and an auth control had become the same widget. Replaced by an
  // explicit Login/Logout pair in the header and the derived `isStaff`.

  private summaryAbort: AbortController | null = null;

  /**
   * Ask the summariser. Calls `/search/summary` and NOTHING else.
   *
   * Deliberately not part of `loadData()`: it touches no result signal, so the three search columns
   * are untouched whether this succeeds, fails or is never called. That separation is also what
   * keeps a model call off every keystroke of an ordinary keyword search.
   *
   * Gated on `isStaff()`, not `isAuthenticated()`. The endpoint is privileged-only, so an
   * authenticated user WITHOUT a staff role would otherwise send a guaranteed 401 straight into
   * the fetch interceptor's refresh-and-replay — the exact storm not sending it avoids.
   */
  async loadSummary() {
    const q = this.summaryQuery().trim();

    this.summaryAbort?.abort();

    if (!q || !this.isStaff()) {
      this.summary.set(null);
      this.summaryCitations.set([]);
      this.summaryReason.set(null);
      this.summaryCostCad.set(null);
      this.summaryUsage.set(null);
      this.summaryLoading.set(false);
      return;
    }

    if (this.config.USE_MOCK_DATA) {
      // Demo mode must not reach the API. `null` with a reason renders as "nothing to show"
      // rather than hanging on the loading sentinel.
      this.summary.set(null);
      this.summaryCitations.set([]);
      this.summaryReason.set('mock_mode');
      this.summaryLoading.set(false);
      return;
    }

    const abort = new AbortController();
    this.summaryAbort = abort;

    this.summaryLoading.set(true);
    this.summary.set(null);
    this.summaryCitations.set([]);
    this.summaryReason.set(null);
    this.summaryCostCad.set(null);
    this.summaryUsage.set(null);

    try {
      const res = await this.fetchWithRetry(
        `${this.getBasePath()}/search/summary?keywords=${encodeURIComponent(q)}&fuzzy=true`,
        { signal: abort.signal }
      );
      if (!res.ok) throw new Error(`Summary API returned status ${res.status}`);
      const data = await res.json();

      this.summary.set(data?.summary ?? null);
      this.summaryCitations.set(data?.citations ?? []);
      this.summaryCostCad.set(data?.estimatedCostCad ?? null);
      this.summaryUsage.set(data?.usage ?? null);
      // `summary: null` with a reason is a legitimate answer, not a failure — the corpus had
      // nothing, or the feature is switched off. The page distinguishes them for the user.
      this.summaryReason.set(data?.reason ?? null);
    } catch (err) {
      // A superseded request is not an outage: a newer loadSummary() owns these signals now, so
      // leave them alone rather than blanking the answer the user is about to read.
      if (this.isAbortError(err)) return;
      console.error('[Registry loadSummary] failed:', err);
      this.summary.set(null);
      this.summaryCitations.set([]);
      this.summaryReason.set('error');
    } finally {
      if (this.summaryAbort === abort) this.summaryLoading.set(false);
    }
  }

  /**
   * Container counts from `GET /db/stats`.
   *
   * The route is behind authMiddleware, so an anonymous caller gets a 401 straight into the
   * fetch interceptor's refresh-and-replay — same reason loadSummary() gates on isStaff().
   * Counts documents and projects, NOT chunks: there is no passage total to read here.
   */
  dbStats = signal<{ projects: number; trackProjects: number; unlinkedProjects: number; documents: number; boundaries: number } | null>(null);

  async loadDbStats() {
    if (!this.isStaff() || this.config.USE_MOCK_DATA) return;
    try {
      const res = await fetch(`${this.getBasePath()}/db/stats`);
      if (!res.ok) return;
      const data = await res.json();
      this.dbStats.set(data?.stats ?? null);
    } catch (err) {
      console.warn('[Registry loadDbStats] failed:', err);
    }
  }

  resetSelection() {
    this.selectedProject.set(null);
    this.selectedDocument.set(null);
  }

  /** Tick or untick one value of a multi-select filter. */
  toggleFilterValue(filter: WritableSignal<Set<string>>, value: string) {
    const next = new Set(filter());
    if (!next.delete(value)) next.add(value);
    filter.set(next);
  }

  toggleBoundaryFilter(layer: string, name: string) {
    const current = this.boundaryFilter();
    const next = new Set(current[layer] || []);
    if (!next.delete(name)) next.add(name);
    this.boundaryFilter.set({ ...current, [layer]: next });
  }

  clearFilters() {
    this.gatingFilter.set(new Set());
    this.sectorFilter.set(new Set());
    this.regionFilter.set(new Set());
    this.boundaryFilter.set({});
  }

  selectProject(proj: Project | null) {
    this.selectedProject.set(proj);
    this.selectedDocument.set(null);
  }

  selectDocument(doc: Document | null) {
    this.selectedDocument.set(doc);
    this.selectedProject.set(null);
  }

  /**
   * Read one document by id, for callers that hold ids rather than a loaded row — an AI summary
   * citation, for instance.
   *
   * `projectId` is the Cosmos partition key. Passing it turns a cross-partition query into a point
   * read, so supply it whenever the caller already knows it.
   *
   * Returns null when the API says 403/404. A document the caller may not read and a document that
   * does not exist are deliberately the same answer here: both mean "nothing to show", and telling
   * them apart in the UI would leak the existence of hidden rows.
   */
  async fetchDocument(documentId: string, projectId?: string): Promise<Document | null> {
    const query = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
    const res = await fetch(`${this.getBasePath()}/documents/${encodeURIComponent(documentId)}${query}`);
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Could not load the document (HTTP ${res.status}).`);
    return await res.json();
  }

  /**
   * Ask the API for a short-lived presigned URL for a document's stored file.
   *
   * The API gates this by the same read ACL as the metadata, so a document the user cannot see
   * returns 403 rather than a link. Throws with a message meant for the user.
   *
   * ponytail: map-explorer.component.ts has this same fetch inline; point it here next time that
   * file is touched.
   */
  async getDownloadUrl(documentId: string, projectId?: string): Promise<string> {
    const query = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
    const res = await fetch(`${this.getBasePath()}/documents/${encodeURIComponent(documentId)}/download${query}`);
    if (!res.ok) {
      throw new Error(res.status === 403
        ? 'You do not have permission to download this document.'
        : `Could not prepare download (HTTP ${res.status}).`);
    }
    const { url } = await res.json();
    if (!url) throw new Error('The API did not return a download link.');
    return url;
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
        body: formData
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
    // Bounded. Extraction is a batch job that may not be running at all, and an unbounded
    // poll left the UI pinned at 95% "Extracting..." forever with no way to tell the
    // difference between slow and never.
    const POLL_INTERVAL_MS = 2500;
    const MAX_POLL_MS = 5 * 60 * 1000;
    const maxAttempts = Math.ceil(MAX_POLL_MS / POLL_INTERVAL_MS);
    let attempts = 0;

    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`${basePath}/documents/${docId}`);
        if (!res.ok) return;
        const doc = await res.json();

        const cur = this.activeIngestion();
        let currentProg = cur ? cur.progress : 50;
        if (currentProg < 95) currentProg += 5;

        if (doc.contentExtracted) {
          clearInterval(interval);
          this.activeIngestion.set({ fileName: doc.displayName, progress: 100, status: 'Extraction complete!' });
          this.loadData();
          return;
        }
        if (doc.contentExtractionError) {
          clearInterval(interval);
          this.activeIngestion.set({ fileName: doc.displayName, progress: 100, status: `Extraction failed: ${doc.contentExtractionError}` });
          return;
        }
        if (attempts >= maxAttempts) {
          clearInterval(interval);
          this.activeIngestion.set({
            fileName: doc.displayName,
            progress: 100,
            status: 'Upload succeeded, but text extraction has not completed. The file is stored and will be processed when the extraction job next runs.'
          });
          this.loadData();
          return;
        }
        this.activeIngestion.set({ fileName: doc.displayName, progress: currentProg, status: 'Extracting text layout with Docling...' });
      } catch {
        if (attempts >= maxAttempts) {
          clearInterval(interval);
          this.activeIngestion.set({
            fileName: '',
            progress: 100,
            status: 'Upload succeeded, but the extraction status could not be confirmed.'
          });
        }
      }
    }, POLL_INTERVAL_MS);
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

  /**
   * Display markup for one result field, preferring what the SEARCH SERVICE matched.
   *
   * `highlightText` below marks whatever a case-insensitive regex over the raw query can find. The
   * index does not work that way: `en.microsoft` stems, so a search for `flood` matches `flooding`
   * and the client marks neither, while a query token that only survived as a fuzzy variant gets
   * marked here as if it were an exact hit. Server markup is the analyzer's own account of the
   * match, already escaped and balanced.
   *
   * The fallback is not dead code. Results from the Cosmos path carry no highlights — there is no
   * analyzer in that path to ask — and neither do fields the frontend substituted its own text
   * into, so client marking stays the answer for both.
   */
  highlightField(serverMarkup: string | undefined | null, text: string | undefined, query: string): string {
    return serverMarkup || this.highlightText(text, query);
  }

  // `text` is optional because a redacted field arrives undefined; the empty-string guard below
  // already covered it at runtime.
  highlightText(text: string | undefined, query: string): string {
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

  /**
   * Keep the `<mark>` tags in a highlighted string, and neutralise everything else in it.
   *
   * The result goes straight to an `[innerHTML]` binding, so this obeys the same rule as
   * `highlightText`'s other branch: escape, then mark \u2014 never the other way round.
   *
   * It used to do the reverse. Each non-mark part was stripped with `replace(/<[^>]*>/g, '')` \u2014
   * the single pass CodeQL flags as `js/incomplete-multi-character-sanitization` \u2014 and then run
   * through a hand-written table of ~30 entities that turned `&lt;img \u2026&gt;` BACK into a live
   * `<img \u2026>` on the way to the DOM. Measured: the strip alone held up (`[^>]*` swallows a nested
   * `<`, so `<scr<script>ipt>` did not re-form), but the decode after it was the real hole, and it
   * is the step this function performed LAST before returning markup. Angular's own DomSanitizer
   * is what kept that from being an XSS; nothing in this file did.
   *
   * `DOMParser` replaces both halves. `textContent` drops markup without a regex to reason about,
   * and it decodes every HTML entity rather than the thirty someone remembered to list. Whatever
   * comes out is text, and text is escaped before it is concatenated back into markup.
   */
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
        const text = new DOMParser().parseFromString(part, 'text/html').body.textContent ?? '';
        result += this.escapeHtml(text);
      }
    }
    return result;
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

  /**
   * Log out — and, now that the role toggle is gone, the ONLY way to see the public site.
   *
   * Local state is cleared BEFORE the redirect rather than left to it. This used to lean entirely
   * on `window.location.href`, so every path that did not navigate — a null client, a blocked
   * redirect — left the header reading "Logged in as …" over a session that no longer existed.
   */
  /**
   * Drop every trace of the session from local state.
   *
   * Split out of `logout()` so it can be asserted without a test navigating the runner away — the
   * redirect below is the untestable half, and it is not the half that was broken.
   */
  clearAuthState() {
    this.loadedQuery = null;
    sessionStorage.removeItem('isLoggedIn');
    localStorage.removeItem('isLoggedIn');

    this.isAuthenticated.set(false);
    this.isUnauthorized.set(false);
    this.visLevel.set(4);
    this.userName.set('');
    this.resetSelection();
  }

  logout() {
    this.clearAuthState();

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
      return;
    }

    // No Keycloak client — the library never loaded, or init fell through to offline mode. There
    // is no end-session endpoint to visit, but the signals above are already public, so reload to
    // drop any privileged rows still resident in memory. Previously this returned silently and the
    // Logout button appeared to do nothing.
    window.location.reload();
  }
}
