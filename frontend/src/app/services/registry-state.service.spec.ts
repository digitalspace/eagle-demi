import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { RegistryStateService } from './registry-state.service';
import { Project } from '../models/registry.models';

// Any payload loadData() accepts. At module scope because the default stub below needs it before
// any individual spec runs.
const okResponse = (payload: unknown = [{ searchResults: [] }]) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

// Reassign in a spec that needs different behaviour — `sharedFetchSpy.and.resolveTo(...)`. Do NOT
// call spyOn(window, 'fetch') again; jasmine throws once a method is already spied.
let sharedFetchSpy: jasmine.Spy;

// STUB FETCH BEFORE THE SERVICE IS CONSTRUCTED, in every describe that injects it.
//
// The constructor kicks off I/O: initKeycloak() -> authSettled() -> loadData(). With auth disabled
// that runs on inject, so EVERY spec issued a real request, karma answered 404, and loadData()'s
// catch logged "[Registry loadData] API search fetch failed: Error: Projects API returned status
// 404" (registry-state.service.ts:1112). The catch handles it, so no spec ever failed — but the
// rejection settles after the spec that started it has finished, which jasmine 7 reports as a
// run-level ERROR where jasmine 6 swallowed it silently.
//
// Measured before this stub: 41 of the 44 specs leaked one. It was FLAKY rather than merely noisy —
// whether the rejection lands inside the run or after it is a timing race, so the same commit
// exited 0 locally and ERROR in CI.
function stubFetch(): jasmine.Spy {
  return spyOn(window, 'fetch').and.callFake(() => Promise.resolve(okResponse()));
}

// Let the constructor's own loadData() finish before a spec starts, then zero the call count.
//
// Without this the two are racing: a spec that sets `.and.rejectWith(...)` and awaits its own
// loadData() can have the constructor's earlier, successful load land afterwards and clear the
// error banner it just asserted. It also keeps `expect(sharedFetchSpy).not.toHaveBeenCalled()`
// meaning "this spec issued no request" rather than "nothing has ever fetched", which is the
// claim those specs are actually making.
async function settleInitialLoad(service: RegistryStateService): Promise<void> {
  // authReady opens only once /api/me has answered, which is what loadData() waits behind.
  await service.authReady;
  await new Promise(resolve => setTimeout(resolve, 0));
  sharedFetchSpy.calls.reset();
}

describe('RegistryStateService', () => {
  let service: RegistryStateService;

  beforeEach(async () => {
    localStorage.clear();

    sharedFetchSpy = stubFetch();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        RegistryStateService
      ]
    });
    service = TestBed.inject(RegistryStateService);
    await settleInitialLoad(service);
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
    const fetchSpy = sharedFetchSpy.and.resolveTo(new Response(JSON.stringify(mockResponse), {
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
    const fetchSpy = sharedFetchSpy.and.resolveTo(new Response(JSON.stringify(mockResponse), {
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

  it('should build sector chips from the data, merging whitespace twins, and select them exactly', () => {
    // Every value here is a real one from dev, including the trailing-space twin. The chips this
    // replaced were Energy / Mining / Transportation matched by substring: 'Coal Mines' was
    // reachable by none of them, 'Power Plants' was not 'Energy', and the two Groundwater rows
    // would have counted as two different sectors.
    const mockProjects: any[] = [
      { id: 'p1', name: 'Coal A', sector: 'Coal Mines', gatingState: 'admitted' },
      { id: 'p2', name: 'Coal B', sector: 'Coal Mines', gatingState: 'admitted' },
      { id: 'p3', name: 'Plant A', sector: 'Power Plants', gatingState: 'admitted' },
      { id: 'p4', name: 'Water A', sector: 'Groundwater Extraction', gatingState: 'admitted' },
      { id: 'p5', name: 'Water B', sector: 'Groundwater Extraction ', gatingState: 'admitted' },
      { id: 'p6', name: 'Unclassified', gatingState: 'admitted' }
    ];
    service.projects.set(mockProjects);

    const options = service.sectorOptions();

    // 'all' leads and counts every matching project, including the one with no sector.
    expect(options[0]).toEqual({ value: 'all', label: 'All Sectors', count: 6 });
    // Sorted by count, and the whitespace pair is ONE entry of 2, not two of 1.
    expect(options.slice(1)).toEqual([
      { value: 'Coal Mines', label: 'Coal Mines', count: 2 },
      { value: 'Groundwater Extraction', label: 'Groundwater Extraction', count: 2 },
      { value: 'Power Plants', label: 'Power Plants', count: 1 }
    ]);

    // Clicking a chip returns exactly the count it advertised.
    service.sectorFilter.set('Coal Mines');
    expect(service.filteredProjectsNoQuery()!.map(p => p.id)).toEqual(['p1', 'p2']);

    service.sectorFilter.set('Groundwater Extraction');
    expect(service.filteredProjectsNoQuery()!.map(p => p.id)).toEqual(['p4', 'p5']);
  });

  it('should count sectors under the OTHER active filters, so a chip cannot promise rows it will not return', () => {
    const mockProjects: any[] = [
      { id: 'p1', name: 'Coal A', sector: 'Coal Mines', gatingState: 'admitted', region: 'Peace' },
      { id: 'p2', name: 'Coal B', sector: 'Coal Mines', gatingState: 'admitted', region: 'Skeena' }
    ];
    service.projects.set(mockProjects);
    service.regionFilter.set('Peace');

    const coal = service.sectorOptions().find(o => o.value === 'Coal Mines');
    expect(coal!.count).toBe(1);

    service.sectorFilter.set('Coal Mines');
    expect(service.filteredProjectsNoQuery()!.map(p => p.id)).toEqual(['p1']);
  });

  it('should keep the selected sector as a zero chip when the other filters empty it', () => {
    // Otherwise the chip vanishes while sectorFilter() still holds it: an empty map, nothing
    // rendered active, and no control left to clear the filter that emptied it.
    const mockProjects: any[] = [
      { id: 'p1', name: 'Coal A', sector: 'Coal Mines', gatingState: 'admitted', region: 'Peace' },
      { id: 'p2', name: 'Plant A', sector: 'Power Plants', gatingState: 'admitted', region: 'Skeena' }
    ];
    service.projects.set(mockProjects);
    service.sectorFilter.set('Coal Mines');
    service.regionFilter.set('Skeena');

    const coal = service.sectorOptions().find(o => o.value === 'Coal Mines');
    expect(coal).toEqual({ value: 'Coal Mines', label: 'Coal Mines', count: 0 });
    expect(service.filteredProjectsNoQuery()).toEqual([]);
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
      sharedFetchSpy.and.rejectWith(new Error('network down'));

      await service.loadData();

      expect(service.projects()).toEqual([]);
      expect(service.documents()).toEqual([]);
      expect(service.loadError()).toBeTruthy();
    });

    it('should clear a previous error at the start of a new load', async () => {
      sharedFetchSpy.and.rejectWith(new Error('network down'));
      await service.loadData();
      expect(service.loadError()).toBeTruthy();

      // A subsequent successful load must clear the banner. loadData fetches projects AND
      // documents, so build a fresh Response per call — a body can only be read once.
      sharedFetchSpy.and.callFake(async () =>
        new Response(JSON.stringify([{ searchResults: [] }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
      await service.loadData();

      expect(service.loadError()).toBeNull();
    });
  });

  // The API answers with TWO project id-spaces on a document row: `project` is the {_id, name}
  // pair eagle-public's templates bind, whose `_id` is the EAGLE ObjectId, and `projectId` is the
  // DEMI id — the Cosmos partition key, and the id-space `Project.id` holds here. Taking this
  // field from the pair compared across id-spaces: `filteredDocuments` and
  // `map-explorer.getProjDocCount` both match it against `Project.id`, so every per-project
  // document count read 0 and the document list emptied on every page but /search.
  describe('document project ids', () => {
    const byDataset = (url: string) => {
      if (url.includes('dataset=Project')) {
        return okResponse([{
          searchResults: [{ _id: '588511c4aaecd9001b826192', id: '207', name: 'Site C', sector: 'Energy' }],
          count: 1
        }]);
      }
      if (url.includes('dataset=Document')) {
        return okResponse([{
          searchResults: [{
            _id: 'doc1',
            displayName: 'Application',
            projectId: '207',
            project: { _id: '588511c4aaecd9001b826192', name: 'Site C' },
            projectName: 'Site C',
            isPublished: true
          }],
          count: 1
        }]);
      }
      return okResponse([{ searchResults: [], count: 0 }]);
    };

    it('keeps the DEMI project id, not the Eagle one the row also carries', async () => {
      sharedFetchSpy.and.callFake((input: any) => Promise.resolve(byDataset(String(input))));

      await service.loadData();

      const [doc] = service.documents()!;
      expect(doc.projectId).toBe('207');
      expect(doc.projectId).not.toBe('588511c4aaecd9001b826192');
    });

    it('so the document still belongs to its project off the search page', async () => {
      sharedFetchSpy.and.callFake((input: any) => Promise.resolve(byDataset(String(input))));

      await service.loadData();
      service.activePage.set('map');

      expect(service.filteredProjectsNoQuery()!.map(p => p.id)).toEqual(['207']);
      expect(service.filteredDocuments()!.length)
        .withContext('a document whose parent is in view must not be filtered out')
        .toBe(1);
    });
  });

  // Before cancellation existed, the last request to RESOLVE won each signal rather than the last
  // one issued — and fetchWithRetry's backoff sleeps made that window seconds wide.
  describe('search cancellation', () => {
    it('cancels a superseded search without raising the error banner', async () => {
      sharedFetchSpy.and.callFake((_input: any, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          setTimeout(() => resolve(okResponse([{ searchResults: [] }])), 5);
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
      sharedFetchSpy.and.callFake((_input: any, init?: RequestInit) => {
        inits.push(init);
        return Promise.resolve(okResponse([{ searchResults: [], count: 7 }]));
      });

      service.searchQuery.set('pipeline');
      await service.loadData();

      expect(inits.length).toBe(3);
      expect(inits.every(i => !!i?.signal)).toBeTrue();
    });

    it('records the index-wide total the API reports', async () => {
      sharedFetchSpy.and.callFake(() =>
        Promise.resolve(okResponse([{ searchResults: [], count: 1204 }]))
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

  // Reached whenever the text ITSELF carries <mark> — the document-snippet path in map-explorer,
  // where the text is extracted from an uploaded PDF. The result is bound with [innerHTML].
  describe('sanitizeHighlight', () => {
    it('keeps the mark tags', () => {
      expect(service.highlightText('Peace <mark>River</mark>', ''))
        .toBe('Peace <mark>River</mark>');
    });

    it('does NOT decode escaped markup back into live markup', () => {
      // The defect this replaced: the entity table ran LAST and turned this into a real <img>
      // element immediately before the string reached [innerHTML]. Fails on the old code.
      const out = service.highlightText('&lt;img src=x onerror=alert(1)&gt; <mark>hit</mark>', '');
      expect(out).not.toContain('<img');
      expect(out).toContain('&lt;img');
    });

    it('drops a tag nested inside another tag', () => {
      // A regression guard, not a demonstration: the old single-pass strip handled this one,
      // because `[^>]*` swallows the nested `<` rather than letting the outer tag re-form.
      const out = service.highlightText('<scr<script>ipt>alert(1)</script> <mark>hit</mark>', '');
      expect(out).not.toContain('<script');
      expect(out).toContain('<mark>hit</mark>');
    });

    it('still resolves entities for display, including ones no table listed', () => {
      // `&eacute;` was in the old table; `&sect;` never was, and used to render literally.
      expect(service.highlightText('caf&eacute; &#8212; &sect;1 <mark>hit</mark>', ''))
        .toBe('café — §1 <mark>hit</mark>');
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

  beforeEach(async () => {
    localStorage.clear();
    sharedFetchSpy = stubFetch();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), RegistryStateService]
    });
    service = TestBed.inject(RegistryStateService);
    service.authEnabled.set(true);
    await settleInitialLoad(service);
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

  beforeEach(async () => {
    localStorage.clear();
    sharedFetchSpy = stubFetch();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), RegistryStateService]
    });
    service = TestBed.inject(RegistryStateService);
    service.authEnabled.set(true);
    await settleInitialLoad(service);
  });

  it('issues NO request when the user is not staff', async () => {
    // The whole reason the gate is `isStaff` and not `isAuthenticated`: the endpoint is
    // privileged-only, so a non-staff request is a guaranteed 401 straight into the fetch
    // interceptor's refresh-and-replay.
    const fetchSpy = sharedFetchSpy;
    service.isAuthenticated.set(true);
    service.isUnauthorized.set(true);
    service.summaryQuery.set('pipeline');

    await service.loadSummary();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(service.summary()).toBeNull();
    expect(service.summaryLoading()).toBe(false);
  });

  it('issues NO request for an empty question', async () => {
    const fetchSpy = sharedFetchSpy;
    service.isAuthenticated.set(true);
    service.isUnauthorized.set(false);
    service.summaryQuery.set('   ');

    await service.loadSummary();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Opening a document from an AI summary citation. Both methods take the projectId the citation
  // already carries — it is the Cosmos partition key, and omitting it costs a cross-partition query.

  it('sends the partition key when fetchDocument is given a projectId', async () => {
    const fetchSpy = sharedFetchSpy.and.resolveTo(new Response(JSON.stringify({ id: 'doc1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    const doc = await service.fetchDocument('doc1', 'proj1');

    expect(fetchSpy.calls.mostRecent().args[0]).toContain('/documents/doc1?project=proj1');
    expect(doc).toEqual({ id: 'doc1' } as any);
  });

  it('returns null rather than throwing when fetchDocument is refused', async () => {
    sharedFetchSpy.and.resolveTo(new Response('{}', { status: 403 }));

    await expectAsync(service.fetchDocument('doc1', 'proj1')).toBeResolvedTo(null);
  });

  it('returns the presigned url from getDownloadUrl', async () => {
    sharedFetchSpy.and.resolveTo(new Response(JSON.stringify({ url: 'https://store/file.pdf' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    await expectAsync(service.getDownloadUrl('doc1', 'proj1')).toBeResolvedTo('https://store/file.pdf');
  });

  it('throws a permission message when the download is refused', async () => {
    sharedFetchSpy.and.resolveTo(new Response('{}', { status: 403 }));

    await expectAsync(service.getDownloadUrl('doc1', 'proj1'))
      .toBeRejectedWithError('You do not have permission to download this document.');
  });
});

/**
 * `GET /api/me` is the only source of "what may this caller see". The browser used to read
 * sysadmin / staff / demi-admin off the token itself, which meant the two could disagree with the
 * API that actually redacts the data. Those roles survive as the fallback for an /api/me that
 * hangs or fails, so an unreachable API cannot lock a staffer out of the UI for the session.
 */
describe('RegistryStateService — /api/me gating', () => {
  // The /api/me answer. `undefined` hangs the request, honouring the abort signal the way a real
  // fetch does; `meStatus` other than 200 answers with that status. Every other URL gets the
  // ordinary loadData() stub. Closures, so one spec can answer twice without a second spyOn.
  let meAnswer: { roles: string[]; level: number; tier: string } | undefined;
  let meStatus: number;

  function makeService(): RegistryStateService {
    sharedFetchSpy = spyOn(window, 'fetch').and.callFake((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (url.endsWith('/me')) {
        if (meStatus !== 200) return Promise.resolve(new Response('{}', { status: meStatus }));
        if (meAnswer === undefined) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
          });
        }
        return Promise.resolve(okResponse(meAnswer));
      }
      return Promise.resolve(okResponse());
    });

    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), RegistryStateService]
    });
    const service = TestBed.inject(RegistryStateService);
    service.authEnabled.set(true);
    return service;
  }

  beforeEach(() => {
    localStorage.clear();
    meAnswer = undefined;
    meStatus = 200;
  });

  afterEach(() => {
    RegistryStateService.meTimeoutMs = 5000;
  });

  it('visLevel defaults to 4 before /api/me answers', () => {
    const service = makeService();

    expect(service.visLevel()).toBe(4);
  });

  it('a hung /api/me does not block authReady', async () => {
    RegistryStateService.meTimeoutMs = 50;
    const service = makeService();

    await service.authReady;

    expect(service.visLevel()).toBe(4);
    expect(service.isUnauthorized()).toBe(false);
  });

  it('a failed /api/me falls back to token roles', async () => {
    meStatus = 500;
    const service = makeService();
    await service.authReady;
    service.isAuthenticated.set(true);

    (service as any).keycloak = { tokenParsed: { realm_access: { roles: ['staff'] } } };
    await (service as any).loadVisLevel();

    expect(service.isUnauthorized()).toBe(false);
    expect(service.visLevel()).toBe(4);

    (service as any).keycloak = { tokenParsed: { realm_access: { roles: ['compliance'] } } };
    await (service as any).loadVisLevel();

    expect(service.isUnauthorized()).toBe(true);
  });

  it('the privileged tier clears isUnauthorized, and level alone does not', async () => {
    meAnswer = { roles: ['staff'], level: 2, tier: 'privileged' };
    const service = makeService();
    await service.authReady;
    service.isAuthenticated.set(true);

    await (service as any).loadVisLevel();

    expect(service.visLevel()).toBe(2);
    expect(service.isUnauthorized()).toBe(false);

    // Same level, public tier: `compliance` reads redacted fields without being staff.
    meAnswer = { roles: ['compliance'], level: 2, tier: 'public' };
    await (service as any).loadVisLevel();

    expect(service.visLevel()).toBe(2);
    expect(service.isUnauthorized()).toBe(true);
  });

  it('a project row with no sector renders', async () => {
    meAnswer = { roles: [], level: 4, tier: 'public' };
    const service = makeService();
    await settleInitialLoad(service);

    // What level 4 gets back: the two fields no redactor can remove.
    const redacted = { id: 'p1', name: 'Redacted Project', gatingState: 'admitted' } as Project;
    service.projects.set([redacted]);
    service.debouncedSearchQuery.set('redacted');

    expect(() => service.filteredProjects()).not.toThrow();
    expect(service.filteredProjects()).toEqual([redacted]);
  });
});
