import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { RegistryStateService, chunkFilterStateFrom, epicPublicDownloadUrl } from './registry-state.service';
import { ConfigService } from './config.service';
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

// Forget what is in memory so the next loadData() goes back to the API. Every key, not just one:
// each leg carries its own, and leaving any set skips that leg's request.
function forgetCorpus(service: RegistryStateService): void {
  Object.assign(service as unknown as Record<string, unknown>, {
    loadedProjectQuery: null,
    loadedDocumentQuery: null,
    loadedDocumentDocType: null,
    loadedChunkQuery: null,
    loadedChunkDocType: null
  });
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
    expect(service.boundaryFilter()).toEqual({});
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

    // With no sector ticked, both are returned by filteredProjectsNoQuery because it ignores search query 'Mine'
    expect(service.filteredProjectsNoQuery()).toEqual(mockProjects);

    // But filteredProjects should honor the search query 'Mine'
    expect(service.filteredProjects()).toEqual([mockProjects[0]]);

    // If the sector filter is set to Energy, filteredProjectsNoQuery should filter by sector
    service.sectorFilter.set(new Set(['Energy']));
    expect(service.filteredProjectsNoQuery()).toEqual([mockProjects[1]]);
    // filteredProjects will be empty because Wind B does not match 'Mine'
    expect(service.filteredProjects()).toEqual([]);
  });

  it('should keep only the projects whose centroid falls inside the lasso ring', () => {
    const mockProjects: any[] = [
      { id: 'p1', name: 'Inside', gatingState: 'admitted', centroid: [-123.4, 48.5] },
      { id: 'p2', name: 'Outside', gatingState: 'admitted', centroid: [-119.5, 54.2] },
      { id: 'p3', name: 'No centroid', gatingState: 'admitted' }
    ];
    service.projects.set(mockProjects);

    // Triangle around p1 only. Unclosed on purpose: the ray cast wraps the last vertex to the first.
    service.lassoPolygon.set([[-124, 48], [-122.5, 48], [-123.4, 49.5]]);
    expect(service.filteredProjectsNoQuery()!.map(p => p.id)).toEqual(['p1']);

    service.clearFilters();
    expect(service.filteredProjectsNoQuery()!.map(p => p.id)).toEqual(['p1', 'p2', 'p3']);
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

    // Sorted by count, and the whitespace pair is ONE entry of 2, not two of 1.
    expect(service.sectorOptions()).toEqual([
      { value: 'Coal Mines', label: 'Coal Mines', count: 2 },
      { value: 'Groundwater Extraction', label: 'Groundwater Extraction', count: 2 },
      { value: 'Power Plants', label: 'Power Plants', count: 1 }
    ]);

    // Clicking a chip returns exactly the count it advertised.
    service.sectorFilter.set(new Set(['Coal Mines']));
    expect(service.filteredProjectsNoQuery()!.map(p => p.id)).toEqual(['p1', 'p2']);

    service.sectorFilter.set(new Set(['Groundwater Extraction']));
    expect(service.filteredProjectsNoQuery()!.map(p => p.id)).toEqual(['p4', 'p5']);
  });

  it('should count sectors under the OTHER active filters, so a chip cannot promise rows it will not return', () => {
    const mockProjects: any[] = [
      { id: 'p1', name: 'Coal A', sector: 'Coal Mines', gatingState: 'admitted', region: 'Peace' },
      { id: 'p2', name: 'Coal B', sector: 'Coal Mines', gatingState: 'admitted', region: 'Skeena' }
    ];
    service.projects.set(mockProjects);
    service.regionFilter.set(new Set(['Peace']));

    const coal = service.sectorOptions().find(o => o.value === 'Coal Mines');
    expect(coal!.count).toBe(1);

    service.sectorFilter.set(new Set(['Coal Mines']));
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
    service.sectorFilter.set(new Set(['Coal Mines']));
    service.regionFilter.set(new Set(['Skeena']));

    const coal = service.sectorOptions().find(o => o.value === 'Coal Mines');
    expect(coal).toEqual({ value: 'Coal Mines', label: 'Coal Mines', count: 0 });
    expect(service.filteredProjectsNoQuery()).toEqual([]);
  });

  it('should OR the values inside one section and AND across sections', () => {
    const mockProjects: any[] = [
      { id: 'p1', name: 'Coal A', sector: 'Coal Mines', gatingState: 'admitted', region: 'Peace' },
      { id: 'p2', name: 'Plant A', sector: 'Power Plants', gatingState: 'admitted', region: 'Peace' },
      { id: 'p3', name: 'Coal B', sector: 'Coal Mines', gatingState: 'admitted', region: 'Skeena' },
      { id: 'p4', name: 'Wind A', sector: 'Wind Energy', gatingState: 'admitted', region: 'Peace' }
    ];
    service.projects.set(mockProjects);

    // OR inside the sector section.
    service.sectorFilter.set(new Set(['Coal Mines', 'Power Plants']));
    expect(service.filteredProjectsNoQuery()!.map(p => p.id)).toEqual(['p1', 'p2', 'p3']);

    // AND across sections: adding a region narrows the sector set rather than replacing it.
    service.regionFilter.set(new Set(['Peace']));
    expect(service.filteredProjectsNoQuery()!.map(p => p.id)).toEqual(['p1', 'p2']);

    // Facet counts are taken under every OTHER section, so they stay honest under the AND.
    const counts = new Map(service.sectorOptions().map(o => [o.value, o.count]));
    expect(counts.get('Coal Mines')).toBe(1);
    expect(counts.get('Wind Energy')).toBe(1);
    expect(counts.get('Power Plants')).toBe(1);
  });

  it('should constrain by two boundary layers at once', () => {
    const mockProjects: any[] = [
      { id: 'p1', name: 'A', gatingState: 'admitted', regionalDistrict: 'Capital', municipality: 'Victoria' },
      { id: 'p2', name: 'B', gatingState: 'admitted', regionalDistrict: 'Capital', municipality: 'Sooke' },
      { id: 'p3', name: 'C', gatingState: 'admitted', regionalDistrict: 'Nanaimo', municipality: 'Victoria' }
    ];
    service.projects.set(mockProjects);

    service.boundaryFilter.set({
      regionalDistricts: new Set(['Capital']),
      municipalities: new Set(['Victoria', 'Sooke'])
    });

    // Regional district AND municipality, with the two municipalities OR'd.
    expect(service.filteredProjectsNoQuery()!.map(p => p.id)).toEqual(['p1', 'p2']);
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
    service.sectorFilter.set(new Set(['Energy'])); // 'p1' (Mining) is excluded from filteredProjectsNoQuery now
    expect(service.filteredDocuments()).toEqual([]);
  });

  // loadData used to swallow any API failure and substitute mock projects, so a broken
  // backend rendered as a healthy demo full of fictional data. It must fail visibly.
  describe('loadData failure handling', () => {
    // The constructor's own load already cached the empty query; these specs exercise the fetch.
    beforeEach(() => forgetCorpus(service));

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
  describe('loadData cache guard', () => {
    it('refetches when a query is set but the chunks were cleared', async () => {
      Object.assign(service as unknown as Record<string, unknown>, {
        loadedProjectQuery: 'mine',
        loadedDocumentQuery: 'mine',
        loadedDocumentDocType: '',
        loadedChunkQuery: 'mine',
        loadedChunkDocType: ''
      });
      service.searchQuery.set('mine');
      service.projects.set([]);
      service.documents.set([]);
      service.documentChunks.set(null);
      sharedFetchSpy.calls.reset();

      await service.loadData();

      expect(sharedFetchSpy).toHaveBeenCalled();
      expect(service.documentChunks()).not.toBeNull();
    });
  });

  describe('document type filter', () => {
    beforeEach(() => forgetCorpus(service));

    const urls = () => sharedFetchSpy.calls.all().map(call => String(call.args[0]));
    const docUrl = () => urls().find(u => u.includes('dataset=Document&'));
    const chunkUrl = () => urls().find(u => u.includes('dataset=DocumentChunk'));

    it('narrows both the document and the passage read with and[type]', async () => {
      // `and[type]`, NOT a bare `type=`: the endpoint reads filters only from the `and[...]`
      // spelling and refuses a parameter it does not know with a 400, so the bare form is a
      // rejected request rather than a narrower search.
      service.searchQuery.set('caribou');
      service.selectedDocType.set('5cf00c03a266b7e1877504ca');

      await service.loadData();

      expect(docUrl()).toContain('and%5Btype%5D=5cf00c03a266b7e1877504ca');
      expect(chunkUrl()).toContain('and%5Btype%5D=5cf00c03a266b7e1877504ca');
      // The project read has no document type to narrow by.
      expect(urls().find(u => u.includes('dataset=Project'))).not.toContain('and%5Btype%5D');
    });

    it('sends every id a label carries as one comma-separated filter', async () => {
      // One request, not one per id: the API reads `,` as a multi-select and ORs the terms.
      service.searchQuery.set('caribou');
      service.selectedDocType.set('id2002,id2018');

      await service.loadData();

      expect(docUrl()).toContain('and%5Btype%5D=id2002%2Cid2018');
      expect(urls().filter(u => u.includes('dataset=Document&')).length).toBe(1);
    });

    it('sends no type at all when none is picked', async () => {
      service.searchQuery.set('caribou');

      await service.loadData();

      expect(urls().some(u => u.includes('type'))).toBeFalse();
    });

    it('re-runs the search when only the type changed', async () => {
      service.searchQuery.set('mine');
      await service.loadData();
      sharedFetchSpy.calls.reset();

      // Same query, same corpus in memory: the cache guard holds.
      await service.loadData();
      expect(sharedFetchSpy).not.toHaveBeenCalled();

      service.selectedDocType.set('5cf00c03a266b7e1877504ca');
      await service.loadData();

      expect(docUrl()).toContain('and%5Btype%5D=5cf00c03a266b7e1877504ca');
    });

    it('loads the options from the doctype list, one per label', async () => {
      // The lookup carries a row per legislation, so the same type appears twice with an id each.
      sharedFetchSpy.and.callFake((input: any) => Promise.resolve(
        String(input).includes('dataset=List')
          ? okResponse([{
            searchResults: [
              { _id: 'id2018', name: 'Certificate Package', legislation: 2018 },
              { _id: 'idletter', name: 'Amendment Package', legislation: 2002 },
              { _id: 'id2002', name: 'Certificate Package', legislation: 2002 },
              { _id: 'idnameless', name: '', legislation: 2002 }
            ],
            count: 4
          }])
          : okResponse()));

      await service.loadDocTypes();

      expect(String(sharedFetchSpy.calls.mostRecent().args[0]))
        .toContain('dataset=List&and%5Btype%5D=doctype');
      expect(service.docTypeOptions()).toEqual([
        { value: 'idletter', label: 'Amendment Package' },
        { value: 'id2018,id2002', label: 'Certificate Package' }
      ]);
    });

    /** The doctype lookup answers with `rows`; everything else gets the empty default. */
    const docTypeAnswer = (rows: unknown[]) => (input: unknown) => Promise.resolve(
      String(input).includes('dataset=List')
        ? okResponse([{ searchResults: rows, count: rows.length }])
        : okResponse());

    it('reads the doctype lookup again after it answered with no types', async () => {
      // A 200 carrying an empty List is a lookup that is not seeded yet, not an answer. Caching it
      // hides the picker for the rest of the session however many screens the user opens.
      sharedFetchSpy.and.callFake(docTypeAnswer([]));
      await service.loadDocTypes();
      expect(service.docTypeOptions()).toEqual([]);

      sharedFetchSpy.and.callFake(docTypeAnswer([{ _id: 'id2018', name: 'Certificate Package' }]));
      await service.loadDocTypes();

      expect(service.docTypeOptions()).toEqual([{ value: 'id2018', label: 'Certificate Package' }]);
    });

    it('reads the doctype lookup once when it answered with types', async () => {
      sharedFetchSpy.and.callFake(docTypeAnswer([{ _id: 'id2018', name: 'Certificate Package' }]));
      await service.loadDocTypes();
      sharedFetchSpy.calls.reset();

      await service.loadDocTypes();

      expect(urls().filter(u => u.includes('dataset=List')).length).toBe(0);
      expect(service.docTypeOptions()).toEqual([{ value: 'id2018', label: 'Certificate Package' }]);
    });

    it('reuses the loaded project list when only the type changed', async () => {
      // The project read carries no type, so re-issuing it on a type pick costs a 500-row request
      // and a re-map for an answer already in memory.
      sharedFetchSpy.and.callFake((input: any) => Promise.resolve(
        String(input).includes('dataset=Project')
          ? okResponse([{ searchResults: [{ _id: 'p1', id: 'p1', name: 'Site C' }], count: 1 }])
          : okResponse()));
      service.searchQuery.set('mine');
      await service.loadData();
      const loaded = service.projects();
      sharedFetchSpy.calls.reset();

      service.selectedDocType.set('id2018');
      await service.loadData();

      expect(urls().some(u => u.includes('dataset=Project'))).toBeFalse();
      expect(docUrl()).toContain('and%5Btype%5D=id2018');
      // The same array, not an equal one: a re-map would answer toEqual and fail this.
      expect(service.projects()).toBe(loaded);
    });

    it('reads the projects again when the query changed', async () => {
      service.searchQuery.set('mine');
      service.selectedDocType.set('id2018');
      await service.loadData();
      sharedFetchSpy.calls.reset();

      service.searchQuery.set('caribou');
      await service.loadData();

      expect(urls().find(u => u.includes('dataset=Project'))).toContain('keywords=caribou');
    });

    it('refetches after a failed search when the type is put back', async () => {
      // The failed attempt must not leave the successful one before it as the cache key. It did:
      // reverting the type hit the guard, which had already cleared the banner, leaving an empty
      // list and no way to retry.
      service.searchQuery.set('mine');
      await service.loadData();

      service.selectedDocType.set('id2018');
      sharedFetchSpy.and.rejectWith(new Error('network down'));
      await service.loadData();
      expect(service.loadError()).toBeTruthy();

      sharedFetchSpy.and.callFake(() => Promise.resolve(okResponse()));
      sharedFetchSpy.calls.reset();
      service.setDocType('');
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(docUrl()).toBeDefined();
      expect(docUrl()).not.toContain('and%5Btype%5D');
      expect(service.loadError()).toBeNull();
    });

    it('goes when the filters do, so a screen with no picker is not left narrowed', async () => {
      // clearFilters runs on every route change. The map and the Projects scope render no picker,
      // so a type surviving one would narrow their document counts invisibly.
      service.searchQuery.set('mine');
      service.selectedDocType.set('id2018');
      await service.loadData();

      service.clearFilters();

      expect(service.selectedDocType()).toBe('');
    });

    it('fires no request of its own when the filters go', async () => {
      // The route change clears the filters BEFORE it sets the new `?q=`, so a load from here reads
      // the old query — for a screen that shows neither documents nor passages. Worse, when the two
      // queries match, that read is not superseded and its answer lands on the new screen.
      service.searchQuery.set('mine');
      service.selectedDocType.set('id2018');
      await service.loadData();
      sharedFetchSpy.calls.reset();

      service.clearFilters();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(sharedFetchSpy).not.toHaveBeenCalled();
    });

    it('leaves the next load a cache miss, so the screen that arrives reads unfiltered', async () => {
      // Clearing without loading is only safe if the load the route does next still goes to the
      // API. Same query as before on purpose: the type is the only cache key that changed.
      service.searchQuery.set('mine');
      service.selectedDocType.set('id2018');
      await service.loadData();
      sharedFetchSpy.calls.reset();

      service.clearFilters();
      await service.loadData();

      expect(docUrl()).toBeDefined();
      expect(docUrl()).not.toContain('and%5Btype%5D');
    });

    it('forgets the pick and the options at logout', async () => {
      // The lookup is an authenticated read, so its answer belongs to the session that made it.
      sharedFetchSpy.and.callFake((input: any) => Promise.resolve(
        String(input).includes('dataset=List')
          ? okResponse([{ searchResults: [{ _id: 'id2018', name: 'Certificate Package' }], count: 1 }])
          : okResponse()));
      await service.loadDocTypes();
      service.selectedDocType.set('id2018');
      expect(service.docTypeOptions().length).toBe(1);

      service.clearAuthState();

      expect(service.selectedDocType()).toBe('');
      expect(service.docTypeOptions()).toEqual([]);

      // The in-flight promise went too, so the next session reads the lookup itself.
      sharedFetchSpy.calls.reset();
      await service.loadDocTypes();
      expect(urls().some(u => u.includes('dataset=List'))).toBeTrue();
    });

    // A lookup that is still in flight at logout. `release` hands it the answer AFTER the session
    // has ended — the case the abort cannot cover, because a fetch already past the network
    // resolves whatever the controller says.
    const inFlightDocTypes = () => {
      let release: (res: Response) => void = () => undefined;
      let signal: AbortSignal | undefined;
      sharedFetchSpy.and.callFake((input: any, init?: RequestInit) => {
        if (!String(input).includes('dataset=List')) return Promise.resolve(okResponse());
        signal = init?.signal ?? undefined;
        return new Promise<Response>(resolve => { release = resolve; });
      });
      const lookup = service.loadDocTypes();
      return {
        lookup,
        get signal() { return signal; },
        answer: () => release(okResponse([{
          searchResults: [{ _id: 'id2018', name: 'Certificate Package' }],
          count: 1
        }]))
      };
    };

    it('cancels the doctype lookup in flight at logout', async () => {
      const pending = inFlightDocTypes();

      service.clearAuthState();

      expect(pending.signal).toBeDefined();
      expect(pending.signal!.aborted).toBeTrue();

      pending.answer();
      await pending.lookup;
    });

    it('throws away a doctype answer that lands after the logout', async () => {
      const pending = inFlightDocTypes();

      service.clearAuthState();
      pending.answer();
      await pending.lookup;

      // The types were read under a session that no longer exists. Filling the picker now puts the
      // last user's list in front of whoever is at the screen.
      expect(service.docTypeOptions()).toEqual([]);
    });

    it('still fills the picker for the session that comes after the logout', async () => {
      // The guard retires ONE session, not the service: the next login must get its own options.
      service.clearAuthState();
      sharedFetchSpy.and.callFake((input: any) => Promise.resolve(
        String(input).includes('dataset=List')
          ? okResponse([{ searchResults: [{ _id: 'id2018', name: 'Certificate Package' }], count: 1 }])
          : okResponse()));

      await service.loadDocTypes();

      expect(service.docTypeOptions()).toEqual([{ value: 'id2018', label: 'Certificate Package' }]);
    });

    // `meta[0]` on the chunk read, exactly as the API emits it: `dropped.filter` for a filter the
    // live chunks index could not apply, with `degraded.reasons` naming why — see the controller
    // tests 'an unfinished backfill marks the page degraded, with a named reason' and the
    // dropped-keys report. `degraded.unstampedChunks` is deliberately absent: the API is dropping
    // that count and nothing here may depend on it.
    const chunkAnswer = (meta?: Record<string, unknown>) => okResponse([{
      searchResults: [],
      count: 0,
      meta: [{ searchResultsTotal: 0, ...(meta || {}) }]
    }]);

    const answerWith = (meta?: Record<string, unknown>) => sharedFetchSpy.and.callFake((input: any) =>
      Promise.resolve(String(input).includes('dataset=DocumentChunk')
        ? chunkAnswer(meta)
        : okResponse()));

    const unstamped = { degraded: { reasons: ['chunk-parent-fields-unstamped'] } };
    const typeDropped = { dropped: { filter: ['type'], sort: [] } };

    const searchFor = async (query: string, docType: string) => {
      service.searchQuery.set(query);
      service.selectedDocType.set(docType);
      await service.loadData();
    };

    it('calls the passage filter dropped when the answer says the type never reached the chunks', async () => {
      // The words match more documents than the query can be scoped to. The passages below are
      // EVERY type, and the picker says otherwise.
      answerWith(typeDropped);

      await searchFor('caribou', 'id2018');

      expect(service.chunkFilterState()).toBe('dropped');
    });

    it('separates the unstamped cause from the plain dropped one', async () => {
      // Same outcome — no type clause on the chunks query — but this one is the passage index
      // still being filled in, which resolves itself. The two get different words on screen.
      answerWith({ ...unstamped, ...typeDropped });

      await searchFor('caribou', 'id2018');

      expect(service.chunkFilterState()).toBe('dropped-unstamped');
    });

    it('reads the unknown cause as the unstamped one', async () => {
      // The stamp count could not be read rather than measured short. Both clear on their own, so
      // a reader gets the same words: the passage index is still being filled in.
      answerWith({ degraded: { reasons: ['chunk-parent-fields-unknown'] }, ...typeDropped });

      await searchFor('caribou', 'id2018');

      expect(service.chunkFilterState()).toBe('dropped-unstamped');
    });

    it('separates a missing column from a scope that is still being stamped', async () => {
      // The live chunks index has no type column at all, so there is nothing to wait for: an
      // operator has to apply the index definition. Telling this reader to come back later is a
      // promise the deployment will not keep.
      answerWith({ degraded: { reasons: ['chunk-parent-fields-missing'] }, ...typeDropped });

      await searchFor('caribou', 'id2018');

      expect(service.chunkFilterState()).toBe('dropped-missing');
    });

    it('lets the missing column win when the answer names both causes', async () => {
      // The API reports more than one reason at a time. A page that picked the unstamped words
      // here would say the wait is nearly over while the column is not there to fill.
      answerWith({
        degraded: { reasons: ['chunk-parent-fields-unstamped', 'chunk-parent-fields-missing'] },
        ...typeDropped
      });

      await searchFor('caribou', 'id2018');

      expect(service.chunkFilterState()).toBe('dropped-missing');
    });

    it('leaves the filter applied when a parent-fields reason comes without a dropped type', async () => {
      // The API does not emit this pair, and on its own the reason says nothing about the filter.
      // Reporting an unfiltered passage list here would accuse an answer that is fine.
      answerWith(unstamped);

      await searchFor('caribou', 'id2018');

      expect(service.chunkFilterState()).toBe('applied');
    });

    it('leaves the filter applied when the degraded reason is an unrelated one', async () => {
      // Only `dropped.filter` speaks to this filter. Any other reason the API reports says
      // nothing about it.
      answerWith({ degraded: { reasons: ['some-other-reason'] } });

      await searchFor('caribou', 'id2018');

      expect(service.chunkFilterState()).toBe('applied');
    });

    it('leaves the filter applied when some other key was the dropped one', async () => {
      // A dropped `milestone` says nothing about the type filter this screen picked.
      answerWith({ dropped: { filter: ['milestone'], sort: [] } });

      await searchFor('caribou', 'id2018');

      expect(service.chunkFilterState()).toBe('applied');
    });

    it('calls the filter applied when the answer carries no mark at all', async () => {
      answerWith();

      await searchFor('caribou', 'id2018');

      expect(service.chunkFilterState()).toBe('applied');
    });

    it('reports nothing at all when no type is picked, since there is no filter to judge', async () => {
      answerWith({ ...unstamped, ...typeDropped });
      service.searchQuery.set('caribou');

      await service.loadData();

      expect(service.chunkFilterState()).toBeNull();
    });

    // Each state carries its own callout in content-search.component.html. Folding one reason into
    // another's state would put the wrong words on screen with every spec above still green, so
    // the mapping and the whole set of answers are pinned here.
    it('gives each documented reason its own state, and answers nothing outside the four', () => {
      const stateFor = (reason: string) =>
        chunkFilterStateFrom({ ...typeDropped, degraded: { reasons: [reason] } });

      expect(stateFor('chunk-parent-fields-unstamped')).toBe('dropped-unstamped');
      expect(stateFor('chunk-parent-fields-unknown')).toBe('dropped-unstamped');
      expect(stateFor('chunk-parent-fields-missing')).toBe('dropped-missing');

      const answers = new Set([
        chunkFilterStateFrom({}),
        chunkFilterStateFrom(typeDropped),
        stateFor('chunk-parent-fields-unstamped'),
        stateFor('chunk-parent-fields-unknown'),
        stateFor('chunk-parent-fields-missing')
      ]);

      expect([...answers].sort()).toEqual(['applied', 'dropped', 'dropped-missing', 'dropped-unstamped']);
    });

    it('clears the mark on the next load that comes back whole', async () => {
      answerWith(typeDropped);
      await searchFor('caribou', 'id2018');
      expect(service.chunkFilterState()).toBe('dropped');

      // A finished backfill, or the index PUT that adds the parent fields, answers the same request
      // with no mark. Left as it was, the page would keep apologising for an answer that is fine.
      answerWith();
      service.searchQuery.set('moose');
      await service.loadData();

      expect(service.chunkFilterState()).toBe('applied');
    });

  });

  // A passage leg that fails used to answer the same `null` as a search with no query at all, so
  // the page cleared the passages and said nothing — a 502 under a type filter read as "nothing
  // matched" while the document column carried on filling.
  describe('passage leg failure', () => {
    beforeEach(() => forgetCorpus(service));

    const urls = () => sharedFetchSpy.calls.all().map(call => String(call.args[0]));
    const chunkUrl = () => urls().find(u => u.includes('dataset=DocumentChunk'));
    const projectUrls = () => urls().filter(u => u.includes('dataset=Project'));
    const chunkUrls = () => urls().filter(u => u.includes('dataset=DocumentChunk'));
    const docUrls = () => urls().filter(u => u.includes('dataset=Document&'));

    const docRows = () => okResponse([{
      searchResults: [{ _id: 'd1', displayName: 'Assessment Report.pdf', projectId: 'p1' }],
      count: 1
    }]);

    // The chunk leg alone fails; every other read answers, which is the case the old null hid.
    const chunkFailsWith = (status: number) => sharedFetchSpy.and.callFake((input: any) => {
      const url = String(input);
      if (url.includes('dataset=DocumentChunk')) return Promise.resolve(new Response('bad gateway', { status }));
      if (url.includes('dataset=Document&')) return Promise.resolve(docRows());
      return Promise.resolve(okResponse());
    });

    const allOk = () => sharedFetchSpy.and.callFake((input: any) =>
      Promise.resolve(String(input).includes('dataset=Document&') ? docRows() : okResponse()));

    const searchFor = async (query: string, docType: string) => {
      service.searchQuery.set(query);
      service.selectedDocType.set(docType);
      await service.loadData();
    };

    it('reports the passage failure with its status and keeps the documents', async () => {
      chunkFailsWith(502);

      await searchFor('caribou', 'id2018');

      expect(service.chunkLoadError()).toContain('502');
      // Scoped to the passages: the document column answered, so the page-wide banner would
      // wrongly tell the user the rows next to it are unreliable too.
      expect(service.loadError()).toBeNull();
      expect(service.documents()?.length).toBe(1);
      // No count and no filter mark: both describe passages nobody has.
      expect(service.chunkMatchCount()).toBeNull();
      expect(service.chunkFilterState()).toBeNull();
    });

    it('refetches after the failure instead of answering from the cache', async () => {
      // The failed load must NOT commit its query and type as the cache key. Committing them made
      // the Retry control and a re-pick of the same type guarded no-ops, with nothing left to try.
      chunkFailsWith(502);
      await searchFor('caribou', 'id2018');
      sharedFetchSpy.calls.reset();

      allOk();
      await service.loadData();

      expect(chunkUrl()).toBeTruthy();
      expect(service.chunkLoadError()).toBeNull();
    });

    it('retries the passages without re-reading the project list', async () => {
      // The project leg answered and does not depend on the type, so a passage failure must not
      // cost the user the ~370 kB `dataset=Project&pageSize=500` read a second time.
      chunkFailsWith(502);
      await searchFor('caribou', 'id2018');
      expect(projectUrls().length).toBe(1);
      // Not a fixed number: fetchWithRetry issues its own attempts against the 502.
      const chunkReadsBeforeRetry = chunkUrls().length;

      allOk();
      await service.loadData();

      expect(service.chunkLoadError()).toBeNull();
      expect(projectUrls().length).toBe(1);
      // The retry did do its job: the passages were read again.
      expect(chunkUrls().length).toBeGreaterThan(chunkReadsBeforeRetry);
    });

    it('still knows the documents were read under a type', async () => {
      // The rows and the count on screen ARE narrowed by the type, and the picker still shows it.
      // One key for the whole load discarded that fact along with the passages, so a screen that
      // renders no picker kept the narrowed rows under a filter it could not show or undo.
      chunkFailsWith(502);

      await searchFor('caribou', 'id2018');

      expect(service.hasLoadedDocType()).toBeTrue();
    });

    it('retries the passages without re-reading the documents', async () => {
      // Same reasoning as the project leg above: the document read answered, and the type has not
      // changed, so Retry must not spend a second 500-row read on it.
      chunkFailsWith(502);
      await searchFor('caribou', 'id2018');
      expect(docUrls().length).toBe(1);

      allOk();
      await service.loadData();

      expect(service.chunkLoadError()).toBeNull();
      expect(docUrls().length).toBe(1);
      expect(service.documents()?.length).toBe(1);
    });

    it('re-reads the documents when the type changes after the failure', async () => {
      // The other half of the pair: the documents leg is reusable, not frozen. A new type is a new
      // document read, or the rows stay narrowed by the type the picker no longer shows.
      chunkFailsWith(502);
      await searchFor('caribou', 'id2018');
      sharedFetchSpy.calls.reset();

      allOk();
      await searchFor('caribou', 'id2002');

      expect(docUrls().length).toBe(1);
      expect(docUrls()[0]).toContain('and%5Btype%5D=id2002');
    });

    it('refetches the passages when a type is picked after the failure', async () => {
      chunkFailsWith(502);
      await searchFor('caribou', 'id2018');
      sharedFetchSpy.calls.reset();

      allOk();
      service.setDocType('id2002');
      await service.loadData();

      expect(chunkUrl()).toContain('and%5Btype%5D=id2002');
      expect(service.chunkLoadError()).toBeNull();
    });

    it('leaves the no-query branch as it was: no passage leg, no error', async () => {
      // Nothing failed here — there is simply nothing to search inside. This must not raise a
      // callout on a page the user has not typed into.
      allOk();

      await searchFor('', '');

      expect(chunkUrl()).toBeUndefined();
      expect(service.documentChunks()).toEqual([]);
      expect(service.chunkLoadError()).toBeNull();
    });
  });

  describe('eaCertificate', () => {
    beforeEach(() => forgetCorpus(service));

    const withProjects = (rows: unknown[]) => (url: string) =>
      url.includes('dataset=Project')
        ? okResponse([{ searchResults: rows, count: rows.length }])
        : okResponse([{ searchResults: [], count: 0 }]);

    it('carries the value through verbatim, number or state word', async () => {
      // Track uses the column for certificate STATE as well as numbers; normalising either end
      // would drop the ~100 records that say "Withdrawn" or "In progress".
      sharedFetchSpy.and.callFake((input: any) => Promise.resolve(withProjects([
        { id: '207', name: 'Site C', eaCertificate: 'E05-01' },
        { id: '208', name: 'Ajax Mine', eaCertificate: 'Withdrawn' }
      ])(String(input))));

      await service.loadData();

      expect(service.projects()!.map(p => p.eaCertificate)).toEqual(['E05-01', 'Withdrawn']);
    });

    it('leaves it undefined rather than inventing one', async () => {
      // Every other field on this mapping has a fallback; a fabricated certificate number would be
      // a claim about a legal document, and the card keys its whole row off this being absent.
      sharedFetchSpy.and.callFake((input: any) => Promise.resolve(
        withProjects([{ id: '354', name: 'Surrey Langley SkyTrain' }])(String(input))));

      await service.loadData();

      expect(service.projects()![0].eaCertificate).toBeUndefined();
    });
  });

  describe('selectProject — eaCertificate hydration', () => {
    const projA = { id: '207', name: 'Site C', eaCertificate: undefined } as unknown as Project;
    const projB = { id: '208', name: 'Ajax Mine', eaCertificate: undefined } as unknown as Project;

    it('hydrates eaCertificate from /projects/:id when the search result omitted it', async () => {
      // A fresh Response per call: a Response body is single-use, and resolveTo hands every
      // caller the same consumed object.
      sharedFetchSpy.and.callFake(() => Promise.resolve(new Response(JSON.stringify({ eaCertificate: 'E05-01' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })));

      service.selectProject(projA);
      // Two macrotask ticks: fetchWithRetry resolves on the first, res.json() and the signal
      // write land behind the second.
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(service.selectedProject()?.eaCertificate).toBe('E05-01');
      expect(sharedFetchSpy.calls.mostRecent().args[0]).toContain('/projects/207');
    });

    it('does not let a late hydration response overwrite a newer selection', async () => {
      const resolvers: ((res: Response) => void)[] = [];
      sharedFetchSpy.and.callFake(() => new Promise<Response>(resolve => resolvers.push(resolve)));

      service.selectProject(projA);
      service.selectProject(projB);

      // projA's hydration answers last, after the user already moved on to projB.
      resolvers[0](new Response(JSON.stringify({ eaCertificate: 'E05-01' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
      // Two ticks, same as the sibling spec: one for fetchWithRetry, one for res.json() + the write.
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(service.selectedProject()?.id).toBe('208');
      expect(service.selectedProject()?.eaCertificate).toBeUndefined();
    });
  });

  describe('document project ids', () => {
    // The constructor's own load already cached the empty query; these specs exercise the fetch.
    beforeEach(() => forgetCorpus(service));

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

    it('shows an ellipsis for the loading sentinel rather than pairing it with a stale total', () => {
      expect(service.resultCountLabel(undefined, 1204)).toBe('…');
      expect(service.resultCountLabel(null, 1204)).toBe('…');
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

  // The demo runs with no API behind it, so every citation chip on the project summary used to
  // 404. Demo mode and a failed presigned request both end at the public EPIC copy instead — but
  // only for a SEEDED document, whose DEMI id is the Eagle id EPIC serves the same file under.
  const SEEDED_DOC = '588511a0aaecd9001b82316d';
  const SEEDED_DOC_2 = '588511a0aaecd9001b82316e';
  // What createDocument gives a DEMI-native upload: crypto.randomUUID(), which EPIC has never seen.
  const DEMI_NATIVE_DOC = '0f8f4a5e-1c2b-4d3e-9a7b-6c5d4e3f2a1b';

  it('returns the public EPIC url in demo mode without asking the API', async () => {
    TestBed.inject(ConfigService).config['USE_MOCK_DATA'] = true;

    await expectAsync(service.getDownloadUrl('doc1', 'proj1'))
      .toBeResolvedTo('https://projects.eao.gov.bc.ca/api/public/document/doc1/download');
    expect(sharedFetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to the public EPIC url when a seeded document\'s presigned request fails', async () => {
    sharedFetchSpy.and.resolveTo(new Response('{}', { status: 500 }));

    await expectAsync(service.getDownloadUrl(SEEDED_DOC, 'proj1'))
      .toBeResolvedTo(epicPublicDownloadUrl(SEEDED_DOC));
  });

  it('raises the failure for a DEMI-native id rather than sending the reader to EPIC', async () => {
    // The composed URL would name no EPIC document, so the reader would get EPIC's error page with
    // nothing saying why. The failure itself is the honest answer.
    sharedFetchSpy.and.resolveTo(new Response('{}', { status: 500 }));

    await expectAsync(service.getDownloadUrl(DEMI_NATIVE_DOC, 'proj1'))
      .toBeRejectedWithError('Could not prepare download (HTTP 500).');
  });

  it('raises a network failure for a DEMI-native id', async () => {
    sharedFetchSpy.and.rejectWith(new TypeError('Failed to fetch'));

    await expectAsync(service.getDownloadUrl(DEMI_NATIVE_DOC, 'proj1'))
      .toBeRejectedWithError('Failed to fetch');
  });

  it('warns once, not once per click, while the presigned leg is down', async () => {
    const warn = spyOn(console, 'warn');
    sharedFetchSpy.and.rejectWith(new TypeError('Failed to fetch'));

    await service.getDownloadUrl(SEEDED_DOC, 'proj1');
    await service.getDownloadUrl(SEEDED_DOC_2, 'proj1');

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * `GET /api/me` is the only source of "what may this caller see". The browser used to read
 * sysadmin / staff / demi-admin off the token itself, which meant the two could disagree with the
 * API that actually redacts the data. Those roles survive as the fallback for an /api/me that
 * hangs or fails, so an unreachable API cannot lock a staffer out of the UI for the session.
 *
 * The staff UI gate is the server's `staffUi` — the predicate authMiddleware itself 403s on.
 * Nothing the client can derive answers it: `staff` and `compliance` are both level 2 and tier
 * `public`, and `privileged` is false for staff since `staff` left SECURE_ROLES.
 */
describe('RegistryStateService — /api/me gating', () => {
  // The /api/me answer. `undefined` hangs the request, honouring the abort signal the way a real
  // fetch does; `meStatus` other than 200 answers with that status. Every other URL gets the
  // ordinary loadData() stub. Closures, so one spec can answer twice without a second spyOn.
  let meAnswer:
    { roles: string[]; level: number; tier: string; privileged: boolean; staffUi?: boolean }
    | undefined;
  let meStatus: number;
  // Set to hold /me open until the spec resolves it, for the authReady ordering spec.
  let mePending: Promise<Response> | null;

  function makeService(): RegistryStateService {
    sharedFetchSpy = spyOn(window, 'fetch').and.callFake((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (url.endsWith('/me')) {
        if (mePending) return mePending;
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
    mePending = null;
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

  // What a Keycloak `staff` caller actually answers with: level 2, tier 'public', not privileged.
  // Every one of those fields reads the same as the compliance row below.
  it('staffUi true clears isUnauthorized', async () => {
    meAnswer = { roles: ['public', 'staff'], level: 2, tier: 'public', privileged: false, staffUi: true };
    const service = makeService();
    await service.authReady;
    service.isAuthenticated.set(true);

    await (service as any).loadVisLevel();

    expect(service.visLevel()).toBe(2);
    expect(service.isUnauthorized()).toBe(false);
  });

  it('staffUi false keeps isUnauthorized', async () => {
    meAnswer = { roles: ['public', 'compliance'], level: 2, tier: 'public', privileged: false, staffUi: false };
    const service = makeService();
    await service.authReady;
    service.isAuthenticated.set(true);

    await (service as any).loadVisLevel();

    expect(service.visLevel()).toBe(2);
    expect(service.isUnauthorized()).toBe(true);
  });

  // authSettled() awaits loadVisLevel() before resolving authReady, and route guards read
  // isStaff() the moment that gate opens. Drop the await and this spec fails.
  it('authReady resolves only after /api/me has answered', async () => {
    let answer!: (res: Response) => void;
    mePending = new Promise<Response>(resolve => (answer = resolve));

    const service = makeService();
    let settled = false;
    service.authReady.then(() => { settled = true; });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    answer(okResponse({ roles: ['staff'], level: 2, tier: 'public', privileged: false, staffUi: true }));
    await service.authReady;

    expect(settled).toBe(true);
    expect(service.visLevel()).toBe(2);
  });

  it('a project row with no sector renders', async () => {
    meAnswer = { roles: [], level: 4, tier: 'public', privileged: false };
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

/**
 * The server copy of the preferences wins on load. localStorage is the cache that keeps the app
 * usable offline and before `/me/data` answers — if it kept winning, the landing screen chosen on
 * one machine would never follow the user to another.
 */
describe('RegistryStateService — server preference sync', () => {
  const BROWSER_PREFS = { landing: 'map', perPage: 6 };

  function makeService(myData: () => Response): RegistryStateService {
    sharedFetchSpy = spyOn(window, 'fetch').and.callFake((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      return Promise.resolve(url.endsWith('/me/data') ? myData() : okResponse());
    });

    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), RegistryStateService]
    });
    return TestBed.inject(RegistryStateService);
  }

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('demi.prefs', JSON.stringify(BROWSER_PREFS));
  });

  it('overwrites the browser copy with the preferences /me/data returned', async () => {
    const service = makeService(() => okResponse({ prefs: { landing: 'index', perPage: 24 }, lassos: [] }));
    await service.authReady;
    service.isAuthenticated.set(true);

    await (service as any).loadUserData();

    expect(JSON.parse(localStorage.getItem('demi.prefs')!)).toEqual({ landing: 'index', perPage: 24 });
  });

  it('keeps the browser copy when the read fails', async () => {
    const service = makeService(() => new Response('{}', { status: 500 }));
    await service.authReady;
    service.isAuthenticated.set(true);

    await (service as any).loadUserData();

    expect(JSON.parse(localStorage.getItem('demi.prefs')!)).toEqual(BROWSER_PREFS);
  });

  it('issues no request for an anonymous visitor', async () => {
    const service = makeService(() => okResponse({ prefs: null, lassos: [] }));
    await service.authReady;
    service.isAuthenticated.set(false);
    sharedFetchSpy.calls.reset();

    await (service as any).loadUserData();

    expect(sharedFetchSpy).not.toHaveBeenCalled();
  });
});
