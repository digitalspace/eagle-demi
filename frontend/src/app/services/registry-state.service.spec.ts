import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { RegistryStateService } from './registry-state.service';

describe('RegistryStateService', () => {
  let service: RegistryStateService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        RegistryStateService
      ]
    });
    service = TestBed.inject(RegistryStateService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should have correct default signal values', () => {
    expect(service.activeBoundaryLayer()).toBe('regions');
    expect(service.boundaryFilter()).toBe('all');
    expect(service.loadedBoundariesGeoJSON()).toEqual({});
    expect(service.activeBoundaryNames()).toEqual([]);
  });

  it('should compute activeBoundaryNames alphabetically', () => {
    service.activeBoundaryLayers.set(['regionalDistricts']);
    service.loadedBoundariesGeoJSON.set({
      regionalDistricts: [
        { name: 'Capital' },
        { name: 'Alberni-Clayoquot' },
        { name: 'Bulkley-Nechako' }
      ]
    });

    expect(service.activeBoundaryNames()).toEqual([
      'Alberni-Clayoquot',
      'Bulkley-Nechako',
      'Capital'
    ]);
  });

  it('should load boundary geometry from cache if available', async () => {
    const mockData = [{ name: 'Test District', simplifiedGeometry: { type: 'Polygon', coordinates: [] } }];
    service.loadedBoundariesGeoJSON.set({
      regionalDistricts: mockData
    });

    const result = await service.loadBoundaryGeometry('regionalDistricts');
    expect(result).toBe(mockData);
  });

  it('should fetch boundary geometry and update cache if not cached', async () => {
    const mockResponse = [{ name: 'Fetched District' }];
    const fetchSpy = spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify(mockResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    service.activeBoundaryLayers.set(['regionalDistricts']);
    const result = await service.loadBoundaryGeometry('regionalDistricts');

    expect(fetchSpy).toHaveBeenCalled();
    expect(result).toEqual(mockResponse);
    expect(service.loadedBoundariesGeoJSON()['regionalDistricts']).toEqual(mockResponse);
  });

  it('should load single boundary geometry from cache if available', async () => {
    const mockData = [{ name: 'Victoria-Beacon Hill', geometry: { type: 'Polygon', coordinates: [] } }];
    service.loadedBoundariesGeoJSON.set({
      electoralDistricts: mockData
    });

    const result = await service.loadSingleBoundaryGeometry('electoralDistricts', 'Victoria-Beacon Hill');
    expect(result).toBe(mockData[0]);
  });

  it('should fetch single boundary geometry and update cache if not already cached with geometry', async () => {
    const initialCache = [{ name: 'Victoria-Beacon Hill' }];
    service.loadedBoundariesGeoJSON.set({
      electoralDistricts: initialCache
    });

    const mockResponse = { name: 'Victoria-Beacon Hill', geometry: { type: 'Polygon', coordinates: [[1, 2]] } };
    const fetchSpy = spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify(mockResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    const result = await service.loadSingleBoundaryGeometry('electoralDistricts', 'Victoria-Beacon Hill');

    expect(fetchSpy).toHaveBeenCalled();
    expect(result).toEqual(mockResponse);
    expect(service.loadedBoundariesGeoJSON()['electoralDistricts'][0].geometry).toEqual(mockResponse.geometry);
  });

  it('should compute filteredProjectsNoQuery based on active filters but ignore search queries', () => {
    const mockProjects: any[] = [
      { id: 'p1', name: 'Mine A', sector: 'Mining', gatingState: 'admitted', region: 'Thompson-Okanagan' },
      { id: 'p2', name: 'Wind B', sector: 'Energy', gatingState: 'admitted', region: 'Thompson-Okanagan' }
    ];
    service.projects.set(mockProjects);
    service.searchQuery.set('Mine'); // search query set to 'Mine'

    // When sector filter is 'all', both are returned by filteredProjectsNoQuery because it ignores search query 'Mine'
    expect(service.filteredProjectsNoQuery()).toEqual(mockProjects);

    // But filteredProjects should honor the search query 'Mine'
    expect(service.filteredProjects()).toEqual([mockProjects[0]]);

    // If sector filter is set to Energy, filteredProjectsNoQuery should filter by sector
    service.sectorFilter.set('Energy');
    expect(service.filteredProjectsNoQuery()).toEqual([mockProjects[1]]);
    // filteredProjects will be empty because Wind B does not match 'Mine'
    expect(service.filteredProjects()).toEqual([]);
  });

  it('should bypass project-matching check for filteredDocuments when on the search page', () => {
    const mockProjects: any[] = [
      { id: 'p1', name: 'Mine A', sector: 'Mining', gatingState: 'admitted', region: 'Thompson-Okanagan' }
    ];
    const mockDocs: any[] = [
      { id: 'd1', displayName: 'Doc A', projectId: 'p1', gatingState: 'admitted' }
    ];
    service.projects.set(mockProjects);
    service.documents.set(mockDocs);

    // Set search page and keyword that does NOT match project name 'Mine A'
    service.activePage.set('search');
    service.searchQuery.set('Doc A');

    // Projects list will be empty because 'Mine A' doesn't match 'Doc A'
    expect(service.filteredProjects()).toEqual([]);

    // But documents list should successfully find the matching document because it bypasses parent project keyword check
    expect(service.filteredDocuments()).toEqual([mockDocs[0]]);

    // When on the map page, it should require the parent project to be in filteredProjectsNoQuery
    service.activePage.set('map');
    service.sectorFilter.set('Energy'); // 'p1' (Mining) is excluded from filteredProjectsNoQuery now
    expect(service.filteredDocuments()).toEqual([]);
  });

  // loadData used to swallow any API failure and substitute mock projects, so a broken
  // backend rendered as a healthy demo full of fictional data. It must fail visibly.
  describe('loadData failure handling', () => {
    it('should surface an error and NOT substitute mock data when the API fails', async () => {
      spyOn(window, 'fetch').and.rejectWith(new Error('network down'));

      await service.loadData();

      expect(service.projects()).toEqual([]);
      expect(service.documents()).toEqual([]);
      expect(service.loadError()).toBeTruthy();
    });

    it('should clear a previous error at the start of a new load', async () => {
      spyOn(window, 'fetch').and.rejectWith(new Error('network down'));
      await service.loadData();
      expect(service.loadError()).toBeTruthy();

      // A subsequent successful load must clear the banner. loadData fetches projects AND
      // documents, so build a fresh Response per call — a body can only be read once.
      (window.fetch as jasmine.Spy).and.callFake(async () =>
        new Response(JSON.stringify([{ searchResults: [] }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
      await service.loadData();

      expect(service.loadError()).toBeNull();
    });
  });

  // Before cancellation existed, the last request to RESOLVE won each signal rather than the last
  // one issued — and fetchWithRetry's backoff sleeps made that window seconds wide.
  describe('search cancellation', () => {
    const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    it('cancels a superseded search without raising the error banner', async () => {
      spyOn(window, 'fetch').and.callFake((_input: any, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          setTimeout(() => resolve(jsonResponse([{ searchResults: [] }])), 5);
        })
      );

      // The second call supersedes the first. The first must die quietly: a request we cancelled
      // ourselves is not an outage, and blanking the signals here would wipe the newer results.
      const first = service.loadData();
      const second = service.loadData();
      await Promise.all([first, second]);

      expect(service.loadError()).toBeNull();
    });

    it('issues the three searches together, each cancellable', async () => {
      const inits: (RequestInit | undefined)[] = [];
      spyOn(window, 'fetch').and.callFake((_input: any, init?: RequestInit) => {
        inits.push(init);
        return Promise.resolve(jsonResponse([{ searchResults: [], count: 7 }]));
      });

      service.searchQuery.set('pipeline');
      await service.loadData();

      expect(inits.length).toBe(3);
      expect(inits.every(i => !!i?.signal)).toBeTrue();
    });

    it('records the index-wide total the API reports', async () => {
      spyOn(window, 'fetch').and.callFake(() =>
        Promise.resolve(jsonResponse([{ searchResults: [], count: 1204 }]))
      );

      service.searchQuery.set('pipeline');
      await service.loadData();

      expect(service.projectMatchCount()).toBe(1204);
      expect(service.documentMatchCount()).toBe(1204);
      expect(service.chunkMatchCount()).toBe(1204);
    });
  });

  // A column header showing results.length was really showing pageSize, and read as "that is all
  // there is" — there is no paging.
  describe('resultCountLabel', () => {
    it('names the total only when it exceeds the rows on screen', () => {
      expect(service.resultCountLabel(12, 1204)).toBe('12 of 1,204');
      expect(service.resultCountLabel(12, 12)).toBe('12');
      expect(service.resultCountLabel(12, null)).toBe('12');
    });

    it('treats the loading sentinel as zero rather than pairing it with a stale total', () => {
      expect(service.resultCountLabel(undefined, 1204)).toBe('0');
      expect(service.resultCountLabel(null, 1204)).toBe('0');
    });
  });

  // Highlighting used to be reconstructed in the browser from the raw query string. The index
  // stems (en.microsoft), so `flood` matches `flooding` and a regex over the query marks neither.
  describe('highlightField', () => {
    it('prefers the markup the search service returned', () => {
      const server = 'Peace <mark>River</mark>';
      expect(service.highlightField(server, 'Peace River', 'river')).toBe(server);
    });

    it('does NOT re-mark or re-escape what the server already marked', () => {
      // The server escapes once. Running it through highlightText again would decode the entities
      // it emitted and mark inside its own tags.
      const server = 'Tunnels &amp; <mark>bridges</mark>';
      expect(service.highlightField(server, 'Tunnels & bridges', 'bridges')).toBe(server);
    });

    it('falls back to client marking when there is no server markup', () => {
      // Not dead code: the Cosmos fallback path has no analyzer to ask, and neither does a field
      // the frontend replaced with text of its own.
      expect(service.highlightField('', 'Peace River', 'peace'))
        .toBe('<mark>Peace</mark> River');
      expect(service.highlightField(undefined, 'Peace River', 'peace'))
        .toBe('<mark>Peace</mark> River');
    });

    it('still escapes on the fallback path', () => {
      expect(service.highlightField(null, '<b>Peace</b>', ''))
        .toBe('&lt;b&gt;Peace&lt;/b&gt;');
    });
  });

  // The fetch interceptor used to decide "is this our API?" with url.includes(basePath).
  // With the '/api' fallback that matches any third-party URL containing those characters,
  // which would attach the user's Bearer token to it.
  describe('isApiUrl', () => {
    it('should not treat a third-party URL containing /api as our API', () => {
      expect((service as any).isApiUrl('https://evil.example.com/api/steal')).toBe(false);
      expect((service as any).isApiUrl('https://openmaps.gov.bc.ca/geo/pub/ows?service=WFS')).toBe(false);
    });

    it('should match same-origin API requests', () => {
      const base = service.getBasePath();
      expect((service as any).isApiUrl(base + '/search?dataset=Project')).toBe(true);
    });

    it('should not match a same-origin path that merely starts with the same characters', () => {
      expect((service as any).isApiUrl(window.location.origin + '/apiary/not-ours')).toBe(false);
    });
  });

  // Guards the Keycloak redirect-loop fix: routing is path-based (app.config.ts), so the
  // hash never carries a route — cleanUrlParams must drop it entirely without touching
  // pathname/search, since that's the only thing the OAuth response ever lands in.
  describe('cleanUrlParams', () => {
    let replaceStateSpy: jasmine.Spy;
    const originalHash = window.location.hash;
    const originalSearch = window.location.search;

    beforeEach(() => {
      replaceStateSpy = spyOn(window.history, 'replaceState');
    });

    afterEach(() => {
      window.location.hash = originalHash;
    });

    it('should strip an OAuth hash fragment and leave pathname/search untouched', () => {
      window.location.hash = '#state=abc&session_state=xyz&code=def';

      (service as any).cleanUrlParams();

      expect(replaceStateSpy).toHaveBeenCalledWith({}, document.title, window.location.pathname + originalSearch);
    });
  });
});

/**
 * `isStaff` is the single predicate deciding staff-only nav, the /intake route guard, and the
 * gating filters on projects and documents. It replaced a `currentRole` signal that a header
 * toggle could set independently of Keycloak — the two drifted apart in both directions, and
 * nothing covered either of them.
 */
describe('RegistryStateService — isStaff', () => {
  let service: RegistryStateService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), RegistryStateService]
    });
    service = TestBed.inject(RegistryStateService);
    service.authEnabled.set(true);
  });

  it('is false for an anonymous visitor', () => {
    service.isAuthenticated.set(false);
    service.isUnauthorized.set(false);
    expect(service.isStaff()).toBe(false);
  });

  it('is true for an authenticated user carrying a staff role', () => {
    service.isAuthenticated.set(true);
    service.isUnauthorized.set(false);
    expect(service.isStaff()).toBe(true);
  });

  it('is false for an authenticated user WITHOUT a staff role', () => {
    // The state that used to render a clickable-but-dead "EPIC Staff View" button, and that made
    // the summary endpoint fire a guaranteed 401 on every keystroke.
    service.isAuthenticated.set(true);
    service.isUnauthorized.set(true);
    expect(service.isStaff()).toBe(false);
  });

  it('is true when Keycloak is disabled, so local dev is workable', () => {
    // A configuration, not a permission: there is no token to send, so the API still answers with
    // the public corpus.
    service.authEnabled.set(false);
    service.isAuthenticated.set(false);
    expect(service.isStaff()).toBe(true);
  });

  it('follows the auth signals rather than being assignable', () => {
    // The point of deriving it: there is no setter, so no second notion can drift out of step.
    expect((service as unknown as { isStaff: { set?: unknown } }).isStaff.set).toBeUndefined();
  });

  it('clearAuthState drops staff access without waiting for the redirect', () => {
    // logout() used to change no signal at all, leaning entirely on the redirect — so any path
    // that did not navigate left the header claiming a session that no longer existed.
    service.isAuthenticated.set(true);
    service.isUnauthorized.set(false);
    service.userName.set('someone');
    expect(service.isStaff()).toBe(true);

    service.clearAuthState();

    expect(service.isAuthenticated()).toBe(false);
    expect(service.isUnauthorized()).toBe(false);
    expect(service.isStaff()).toBe(false);
    expect(service.userName()).toBe('');
    expect(localStorage.getItem('isLoggedIn')).toBeNull();
  });
});

describe('RegistryStateService — loadSummary gating', () => {
  let service: RegistryStateService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), RegistryStateService]
    });
    service = TestBed.inject(RegistryStateService);
    service.authEnabled.set(true);
  });

  it('issues NO request when the user is not staff', async () => {
    // The whole reason the gate is `isStaff` and not `isAuthenticated`: the endpoint is
    // privileged-only, so a non-staff request is a guaranteed 401 straight into the fetch
    // interceptor's refresh-and-replay.
    const fetchSpy = spyOn(window, 'fetch');
    service.isAuthenticated.set(true);
    service.isUnauthorized.set(true);
    service.summaryQuery.set('pipeline');

    await service.loadSummary();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(service.summary()).toBeNull();
    expect(service.summaryLoading()).toBe(false);
  });

  it('issues NO request for an empty question', async () => {
    const fetchSpy = spyOn(window, 'fetch');
    service.isAuthenticated.set(true);
    service.isUnauthorized.set(false);
    service.summaryQuery.set('   ');

    await service.loadSummary();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Opening a document from an AI summary citation. Both methods take the projectId the citation
  // already carries — it is the Cosmos partition key, and omitting it costs a cross-partition query.

  it('sends the partition key when fetchDocument is given a projectId', async () => {
    const fetchSpy = spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify({ id: 'doc1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    const doc = await service.fetchDocument('doc1', 'proj1');

    expect(fetchSpy.calls.mostRecent().args[0]).toContain('/documents/doc1?project=proj1');
    expect(doc).toEqual({ id: 'doc1' } as any);
  });

  it('returns null rather than throwing when fetchDocument is refused', async () => {
    spyOn(window, 'fetch').and.resolveTo(new Response('{}', { status: 403 }));

    await expectAsync(service.fetchDocument('doc1', 'proj1')).toBeResolvedTo(null);
  });

  it('returns the presigned url from getDownloadUrl', async () => {
    spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify({ url: 'https://store/file.pdf' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    await expectAsync(service.getDownloadUrl('doc1', 'proj1')).toBeResolvedTo('https://store/file.pdf');
  });

  it('throws a permission message when the download is refused', async () => {
    spyOn(window, 'fetch').and.resolveTo(new Response('{}', { status: 403 }));

    await expectAsync(service.getDownloadUrl('doc1', 'proj1'))
      .toBeRejectedWithError('You do not have permission to download this document.');
  });
});
