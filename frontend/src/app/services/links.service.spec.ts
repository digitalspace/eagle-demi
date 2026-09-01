import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { LinksService, ShortLink } from './links.service';
import { RegistryStateService } from './registry-state.service';

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

const LINK: ShortLink = {
  id: 'site-c-eac',
  url: 'https://demi.gov.bc.ca/projects/402',
  note: 'printed handout',
  shortUrl: 'https://demi.gov.bc.ca/s/site-c-eac',
  createdAt: '2026-08-24T00:00:00.000Z',
  createdBy: 'j.okafor',
  updatedAt: null,
  personal: false
};

describe('LinksService', () => {
  let service: LinksService;
  let fetchSpy: jasmine.Spy;

  beforeEach(async () => {
    // Stub before injection: RegistryStateService's constructor issues its own requests.
    fetchSpy = spyOn(window, 'fetch').and.callFake(() => Promise.resolve(jsonResponse([])));

    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), RegistryStateService, LinksService]
    });
    await TestBed.inject(RegistryStateService).authReady;
    await new Promise(resolve => setTimeout(resolve, 0));
    fetchSpy.calls.reset();
    service = TestBed.inject(LinksService);
  });

  it('GETs /links and fills the signal', async () => {
    fetchSpy.and.resolveTo(jsonResponse([LINK]));

    await service.load();

    expect(fetchSpy.calls.mostRecent().args[0]).toBe('/api/links');
    expect(service.links()).toEqual([LINK]);
    expect(service.loading()).toBeFalse();
  });

  it('POSTs the destination, note and custom code, then reloads', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ code: 'abc' }, 201));

    expect(await service.create('https://demi.gov.bc.ca/x', 'poster', 'abc')).toBeTrue();

    const [url, init] = fetchSpy.calls.first().args as [string, RequestInit];
    expect(url).toBe('/api/links');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string))
      .toEqual({ url: 'https://demi.gov.bc.ca/x', note: 'poster', code: 'abc', personal: false });
    // second call is the reload
    expect(fetchSpy.calls.count()).toBe(2);
  });

  it('POSTs the personal flag when the creator ticks it', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ code: 'abc' }, 201));

    await service.create('https://demi.gov.bc.ca/x', '', '', true);

    const [, init] = fetchSpy.calls.first().args as [string, RequestInit];
    expect(JSON.parse(init.body as string).personal).toBeTrue();
  });

  it('PUTs a repoint and DELETEs by code', async () => {
    fetchSpy.and.resolveTo(jsonResponse(LINK));

    await service.repoint('site-c-eac', 'https://demi.gov.bc.ca/y');
    let [url, init] = fetchSpy.calls.first().args as [string, RequestInit];
    expect(url).toBe('/api/links/site-c-eac');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://demi.gov.bc.ca/y' });

    fetchSpy.calls.reset();
    await service.remove('site-c-eac');
    [url, init] = fetchSpy.calls.first().args as [string, RequestInit];
    expect(url).toBe('/api/links/site-c-eac');
    expect(init.method).toBe('DELETE');
  });

  it('surfaces the API error message', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ error: 'Code already in use' }, 409));

    expect(await service.create('https://demi.gov.bc.ca/x', '', 'taken')).toBeFalse();
    expect(service.error()).toBe('Code already in use');
  });
});
