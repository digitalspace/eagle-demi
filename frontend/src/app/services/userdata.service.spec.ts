import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { UserdataService, SavedLasso, SavedQuery } from './userdata.service';
import { RegistryStateService } from './registry-state.service';

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

const LASSO: SavedLasso = {
  slug: 'peace-valley',
  name: 'Peace Valley',
  ring: [[-121, 56], [-120, 56], [-120.5, 56.5]],
  updatedAt: '2026-08-30T00:00:00.000Z'
};

const QUERY: SavedQuery = {
  slug: 'reports-2024',
  name: 'Reports 2024',
  params: 'record=documents&type=Report',
  savedAt: '2026-09-01T00:00:00.000Z'
};

describe('UserdataService', () => {
  let service: UserdataService;
  let fetchSpy: jasmine.Spy;

  beforeEach(async () => {
    // Stub before injection: RegistryStateService's constructor issues its own requests.
    fetchSpy = spyOn(window, 'fetch').and.callFake(() => Promise.resolve(jsonResponse([])));

    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), RegistryStateService, UserdataService]
    });
    await TestBed.inject(RegistryStateService).authReady;
    await new Promise(resolve => setTimeout(resolve, 0));
    fetchSpy.calls.reset();
    service = TestBed.inject(UserdataService);
  });

  afterEach(() => {
    UserdataService.myDataTimeoutMs = 5000;
  });

  it('GETs /me/data and fills the signals', async () => {
    fetchSpy.and.resolveTo(
      jsonResponse({ prefs: { landing: 'search', perPage: 24 }, lassos: [LASSO], queries: [QUERY] })
    );

    await service.loadMyData();

    expect(fetchSpy.calls.mostRecent().args[0]).toBe('/api/me/data');
    expect(service.lassos()).toEqual([LASSO]);
    expect(service.queries()).toEqual([QUERY]);
    expect(service.prefs()).toEqual({ landing: 'search', perPage: 24 });
    expect(service.loading()).toBeFalse();
    expect(service.error()).toBe('');
  });

  it('gives up on a hung /me/data rather than waiting forever', async () => {
    // Startup awaits this read before opening authReady, so an API that never answers would hold
    // every route guard shut. Honours the abort the way a real fetch does.
    UserdataService.myDataTimeoutMs = 20;
    fetchSpy.and.callFake((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
      })
    );

    await service.loadMyData();

    expect(service.loading()).toBeFalse();
    expect(service.prefs()).toBeNull();
  });

  it('surfaces the API error message and keeps the signals as they were', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ error: 'user data read failed' }, 500));

    await service.loadMyData();

    expect(service.error()).toBe('user data read failed');
    expect(service.lassos()).toEqual([]);
    expect(service.prefs()).toBeNull();
    expect(service.loading()).toBeFalse();
  });

  it('PUTs the name and ring, then reloads', async () => {
    // A fresh Response per call: the reload cannot read a body the write already consumed.
    fetchSpy.and.callFake(() => Promise.resolve(jsonResponse({ prefs: null, lassos: [LASSO] })));

    expect(await service.saveLasso('Peace Valley', LASSO.ring)).toBeTrue();

    const [url, init] = fetchSpy.calls.first().args as [string, RequestInit];
    expect(url).toBe('/api/me/lassos');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Peace Valley', ring: LASSO.ring });
    // second call is the reload
    expect(fetchSpy.calls.count()).toBe(2);
    expect(service.lassos()).toEqual([LASSO]);
  });

  it('DELETEs by slug', async () => {
    fetchSpy.and.callFake(() => Promise.resolve(jsonResponse({ prefs: null, lassos: [] })));

    await service.deleteLasso('peace-valley');

    const [url, init] = fetchSpy.calls.first().args as [string, RequestInit];
    expect(url).toBe('/api/me/lassos/peace-valley');
    expect(init.method).toBe('DELETE');
  });

  it('percent-encodes what PUT /me/queries would refuse in params', async () => {
    fetchSpy.and.callFake(() => Promise.resolve(jsonResponse({ prefs: null, lassos: [], queries: [QUERY] })));

    expect(await service.saveQuery('Peace', '?keywords=Site C & D&record=projects')).toBeTrue();

    const [url, init] = fetchSpy.calls.first().args as [string, RequestInit];
    expect(url).toBe('/api/me/queries');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Peace',
      params: 'keywords=Site%20C%20&%20D&record=projects'
    });
    expect(service.queries()).toEqual([QUERY]);
  });

  it('PUTs prefs without a reload', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ landing: 'search', perPage: 12 }));

    expect(await service.putPrefs({ landing: 'search', perPage: 12 })).toBeTrue();

    const [url, init] = fetchSpy.calls.first().args as [string, RequestInit];
    expect(url).toBe('/api/me/prefs');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ landing: 'search', perPage: 12 });
    expect(fetchSpy.calls.count()).toBe(1);
    expect(service.prefs()).toEqual({ landing: 'search', perPage: 12 });
  });
});
