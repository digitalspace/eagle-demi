import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { RegistryStateService } from '../services/registry-state.service';
import {
  PROPONENT_COMPANY_TYPE,
  UnifiedSearchService,
  buildSearchQuery,
  searchKeyword,
} from './unified-search.service';

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

const searchEnvelope = (rows: unknown[], total: number | null = rows.length) => [
  { searchResults: rows, meta: [{ searchResultsTotal: total }] },
];

/** The signal each fetch call was given, in call order. */
const signalsOf = (spy: jasmine.Spy): AbortSignal[] =>
  spy.calls.allArgs().map(([, init]) => (init as RequestInit).signal as AbortSignal);

const urlsOf = (spy: jasmine.Spy): string[] => spy.calls.allArgs().map(([url]) => String(url));

describe('UnifiedSearchService', () => {
  let service: UnifiedSearchService;
  let fetchSpy: jasmine.Spy;

  beforeEach(async () => {
    // Stub before injection: RegistryStateService's constructor issues its own requests.
    fetchSpy = spyOn(window, 'fetch').and.callFake(() => Promise.resolve(jsonResponse([])));

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        RegistryStateService,
        UnifiedSearchService,
      ],
    });
    await TestBed.inject(RegistryStateService).authReady;
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetchSpy.calls.reset();
    service = TestBed.inject(UnifiedSearchService);
  });

  describe('searchKeyword', () => {
    it('searches as an empty keyword below two characters', () => {
      expect(searchKeyword('s')).toBe('');
      expect(searchKeyword('  ')).toBe('');
      expect(searchKeyword(' site ')).toBe('site');
    });
  });

  describe('buildSearchQuery', () => {
    it('writes the parameters in order, one and[] per comma-separated pick', () => {
      expect(
        buildSearchQuery({
          dataset: 'Document',
          keywords: 'site%20c',
          pageNum: 2,
          pageSize: 25,
          sortBy: '-datePosted',
          filters: { type: 'a,b', region: 'Peace' },
        }),
      ).toBe(
        'search?dataset=Document&keywords=site%20c&pageNum=1&pageSize=25&sortBy=-datePosted' +
          '&and[type]=a&and[type]=b&and[region]=Peace&fuzzy=false',
      );
    });

    it('wraps the filters the shared mapping produced, years and typed names included', () => {
      expect(
        buildSearchQuery({
          dataset: 'Project',
          keywords: 'site',
          pageNum: 1,
          pageSize: 25,
          filters: { dateUpdated: '2018', nameContains: 'Site C', type: ['a', 'b'] },
          yearIds: ['dateUpdated'],
          textIds: ['nameContains'],
        }),
      ).toBe(
        'search?dataset=Project&keywords=site&pageNum=0&pageSize=25' +
          '&and[nameContains]=Site%20C&and[type]=a&and[type]=b' +
          '&and[dateUpdatedStart]=2018-01-01&and[dateUpdatedEnd]=2018-12-31&fuzzy=false',
      );
    });
  });

  it('issues one search at the exact URL and fills the signals', async () => {
    fetchSpy.and.resolveTo(jsonResponse(searchEnvelope([{ _id: 'd1' }], 42)));

    const result = await service.search({
      dataset: 'Document',
      keywords: 'site c',
      pageNum: 1,
      pageSize: 25,
      sortBy: '-datePosted',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(urlsOf(fetchSpy)[0]).toBe(
      '/api/search?dataset=Document&keywords=site%20c&pageNum=0&pageSize=25&sortBy=-datePosted&fuzzy=false',
    );
    expect(result?.total).toBe(42);
    expect(service.rows()).toEqual([{ _id: 'd1' }]);
    expect(service.total()).toBe(42);
  });

  it('keeps the rows already on screen while the next search is in flight', async () => {
    fetchSpy.and.resolveTo(jsonResponse(searchEnvelope([{ _id: 'd1' }], 1)));
    await service.search({ dataset: 'Document', keywords: 'site', pageNum: 1, pageSize: 25 });

    let release: (value: Response) => void = () => undefined;
    fetchSpy.and.returnValue(new Promise<Response>((resolve) => (release = resolve)));
    const pending = service.search({
      dataset: 'Document',
      keywords: 'site c',
      pageNum: 1,
      pageSize: 25,
    });

    expect(service.rows()).toEqual([{ _id: 'd1' }]);
    expect(service.loading()).toBeTrue();

    release(jsonResponse(searchEnvelope([{ _id: 'd2' }], 1)));
    await pending;
    expect(service.rows()).toEqual([{ _id: 'd2' }]);
  });

  it('aborts the request a newer pause supersedes', async () => {
    let release: (value: Response) => void = () => undefined;
    fetchSpy.and.returnValue(new Promise<Response>((resolve) => (release = resolve)));
    const first = service.search({
      dataset: 'Document',
      keywords: 'sit',
      pageNum: 1,
      pageSize: 25,
    });

    fetchSpy.and.resolveTo(jsonResponse(searchEnvelope([{ _id: 'd2' }], 1)));
    const second = service.search({
      dataset: 'Document',
      keywords: 'site',
      pageNum: 1,
      pageSize: 25,
    });

    const [firstSignal, secondSignal] = signalsOf(fetchSpy);
    expect(firstSignal.aborted).withContext('older request not aborted').toBeTrue();
    expect(secondSignal.aborted).withContext('newer request aborted').toBeFalse();

    release(jsonResponse(searchEnvelope([{ _id: 'd1' }], 1)));
    expect(await first).toBeNull();
    expect((await second)?.rows).toEqual([{ _id: 'd2' }]);
    // The superseded answer never reaches the signals.
    expect(service.rows()).toEqual([{ _id: 'd2' }]);
  });

  it('reads counts from search/counts, keyed by dataset name', async () => {
    fetchSpy.and.resolveTo(
      jsonResponse([
        { counts: { Project: 3, Document: 9, RecentActivity: null, ProjectNotification: 2 } },
      ]),
    );

    const counts = await service.loadCounts('site c');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(urlsOf(fetchSpy)[0]).toBe('/api/search/counts?keywords=site%20c');
    expect(counts).toEqual({ projects: 3, documents: 9, activities: null, notifications: 2 });
  });

  it('falls back to four one-row searches when search/counts answers 404', async () => {
    fetchSpy.and.callFake((url: string) =>
      Promise.resolve(
        String(url).includes('/search/counts')
          ? jsonResponse({ error: 'not found' }, 404)
          : jsonResponse(searchEnvelope([{}], 7)),
      ),
    );

    const counts = await service.loadCounts('site');

    // One probe, then one search per record type.
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(urlsOf(fetchSpy).slice(1)).toEqual([
      '/api/search?dataset=Project&keywords=site&pageNum=0&pageSize=1&fuzzy=false',
      '/api/search?dataset=Document&keywords=site&pageNum=0&pageSize=1&fuzzy=false',
      '/api/search?dataset=RecentActivity&keywords=site&pageNum=0&pageSize=1&fuzzy=false',
      '/api/search?dataset=ProjectNotification&keywords=site&pageNum=0&pageSize=1&fuzzy=false',
    ]);
    expect(counts).toEqual({ projects: 7, documents: 7, activities: 7, notifications: 7 });

    // The 404 is taken once: a second keyword goes straight to the four searches.
    fetchSpy.calls.reset();
    await service.loadCounts('dam');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(urlsOf(fetchSpy).every((url) => !url.includes('/search/counts'))).toBeTrue();
  });

  it('logs a counts endpoint failure rather than leaving stale badges unexplained', async () => {
    const warn = spyOn(console, 'warn');
    fetchSpy.and.resolveTo(jsonResponse({ error: 'boom' }, 500));

    const counts = await service.loadCounts('site');

    expect(counts).toBeNull();
    expect(service.counts()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the badges of the datasets that answered when one of the four fails', async () => {
    const warn = spyOn(console, 'warn');
    fetchSpy.and.callFake((url: string) => {
      if (String(url).includes('/search/counts')) {
        return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
      }
      return Promise.resolve(
        String(url).includes('dataset=RecentActivity')
          ? jsonResponse({ error: 'boom' }, 500)
          : jsonResponse(searchEnvelope([{}], 7)),
      );
    });

    const counts = await service.loadCounts('site');

    expect(counts).toEqual({ projects: 7, documents: 7, activities: null, notifications: 7 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads grouped passages off a DocumentChunk search', async () => {
    fetchSpy.and.resolveTo(
      jsonResponse(
        searchEnvelope(
          [
            {
              documentId: 'doc-1',
              documentName: 'Application Part A',
              datePosted: '2024-03-01',
              documentType: 'Application',
              matchCount: 5,
              passages: [
                { text: 'first hit', pageNumber: 12, pageNumbered: true },
                { text: 'second hit', pageNumber: 0, pageNumbered: false },
              ],
            },
          ],
          1,
        ),
      ),
    );

    const rows = await service.searchPassages(
      { keywords: 'fish habitat', pageNum: 1, pageSize: 25, sortBy: '-matches' },
      (row) => `/api/documents/${row['documentId']}/download`,
    );

    expect(urlsOf(fetchSpy)[0]).toBe(
      '/api/search?dataset=DocumentChunk&keywords=fish%20habitat&pageNum=0&pageSize=25&sortBy=-matches&fuzzy=true',
    );
    expect(rows).toEqual([
      {
        id: 'doc-1',
        name: 'Application Part A',
        href: '/api/documents/doc-1/download',
        date: '2024-03-01',
        type: 'Application',
        author: null,
        passages: [
          { locator: 12, text: 'first hit', pageNumbered: true },
          // No real page number, so the locator is the passage's place in what came back.
          { locator: 2, text: 'second hit', pageNumbered: false },
        ],
        total: 5,
      },
    ]);
  });

  it('reads the dropdown lists in one page', async () => {
    fetchSpy.and.resolveTo(jsonResponse(searchEnvelope([{ _id: 'l1', name: 'Letter' }])));

    await service.loadLists();

    expect(urlsOf(fetchSpy)[0]).toBe('/api/search?dataset=List&pageSize=250');
  });

  it('reads proponent organizations by company type', async () => {
    fetchSpy.and.resolveTo(jsonResponse(searchEnvelope([{ _id: 'o1', name: 'Acme' }])));

    await service.loadOrganizations();

    expect(urlsOf(fetchSpy)[0]).toBe(
      `/api/search?dataset=Organization&pageNum=0&pageSize=250&sortBy=+name` +
        `&and[companyType]=${PROPONENT_COMPANY_TYPE}&fuzzy=false`,
    );
  });
});
