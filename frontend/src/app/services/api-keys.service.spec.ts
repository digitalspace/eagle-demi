import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ApiKey, ApiKeysService, keyStatus } from './api-keys.service';
import { RegistryStateService } from './registry-state.service';

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

const day = 86_400_000;
const key = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: 'ak_c02da6f1',
  name: 'epic-map-frontend',
  roles: ['demi-service-read'],
  projectScope: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  createdBy: 'j.okafor',
  expiresAt: new Date(Date.now() + 90 * day).toISOString(),
  revokedAt: null,
  lastUsedAt: null,
  ...over
});

describe('ApiKeysService', () => {
  let service: ApiKeysService;
  let fetchSpy: jasmine.Spy;

  beforeEach(async () => {
    fetchSpy = spyOn(window, 'fetch').and.callFake(() => Promise.resolve(jsonResponse([])));

    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), RegistryStateService, ApiKeysService]
    });
    await TestBed.inject(RegistryStateService).authReady;
    await new Promise(resolve => setTimeout(resolve, 0));
    fetchSpy.calls.reset();
    service = TestBed.inject(ApiKeysService);
  });

  it('GETs /admin/api-keys and counts by derived status', async () => {
    fetchSpy.and.resolveTo(jsonResponse([
      key(),
      key({ id: 'b', expiresAt: new Date(Date.now() + 5 * day).toISOString() }),
      key({ id: 'c', revokedAt: '2026-08-20T00:00:00.000Z' })
    ]));

    await service.load();

    expect(fetchSpy.calls.mostRecent().args[0]).toBe('/api/admin/api-keys');
    expect(service.counts()).toEqual({ total: 3, active: 2, expiring: 1, revoked: 1 });
  });

  it('POSTs the mint body and keeps the plaintext until dismissed', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ ...key(), key: 'demi_test_c02da6f1_secret' }, 201));

    expect(await service.mint({ name: 'x', roles: ['demi-service-write'], allowWrite: true })).toBeTrue();

    const [url, init] = fetchSpy.calls.first().args as [string, RequestInit];
    expect(url).toBe('/api/admin/api-keys');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'x', roles: ['demi-service-write'], allowWrite: true });
    expect(service.mintedPlaintext()).toBe('demi_test_c02da6f1_secret');

    service.dismissMinted();
    expect(service.mintedPlaintext()).toBe('');
  });

  it('rotates by minting the replacement before revoking the old key', async () => {
    fetchSpy.and.callFake((_url: string, init?: RequestInit) =>
      Promise.resolve(jsonResponse(init?.method === 'POST' ? { ...key(), key: 'demi_test_new_secret' } : [])));

    expect(await service.rotate(key({ roles: ['demi-service-write'], projectScope: ['402'] }))).toBeTrue();

    const methods = fetchSpy.calls.allArgs().map(([url, init]) => `${(init as RequestInit)?.method || 'GET'} ${url}`);
    expect(methods[0]).toBe('POST /api/admin/api-keys');
    expect(methods).toContain('DELETE /api/admin/api-keys/ak_c02da6f1');
    expect(methods.indexOf('DELETE /api/admin/api-keys/ak_c02da6f1')).toBeGreaterThan(0);
    // A write role carries allowWrite, or the mint route refuses it.
    expect(JSON.parse((fetchSpy.calls.first().args[1] as RequestInit).body as string))
      .toEqual({ name: 'epic-map-frontend', roles: ['demi-service-write'], projectScope: ['402'], allowWrite: true });
  });

  it('surfaces the API error message and mints nothing', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ error: 'Unknown role(s): wizard' }, 400));

    expect(await service.mint({ name: 'x', roles: ['wizard'] })).toBeFalse();
    expect(service.error()).toBe('Unknown role(s): wizard');
    expect(service.mintedPlaintext()).toBe('');
  });

  it('derives status from revokedAt and expiresAt', () => {
    expect(keyStatus(key({ revokedAt: 'x' }))).toBe('Revoked');
    expect(keyStatus(key({ expiresAt: new Date(Date.now() - day).toISOString() }))).toBe('Expired');
    expect(keyStatus(key({ expiresAt: new Date(Date.now() + 5 * day).toISOString() }))).toBe('Expiring');
    expect(keyStatus(key())).toBe('Active');
  });
});
