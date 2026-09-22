import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyCounts, keyStatus, listApiKeys, mintApiKey, replacementFor, revokeApiKey, type ApiKey } from './api-keys';
import { json } from '../test-http';

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
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('keyStatus', () => {
  it('reads Revoked off revokedAt before anything else', () => {
    expect(keyStatus(key({ revokedAt: '2026-08-20T00:00:00.000Z' }))).toBe('Revoked');
  });

  it('calls a past expiry Expired', () => {
    expect(keyStatus(key({ expiresAt: new Date(Date.now() - day).toISOString() }))).toBe('Expired');
  });

  it('calls an expiry inside 30 days Expiring', () => {
    expect(keyStatus(key({ expiresAt: new Date(Date.now() + 5 * day).toISOString() }))).toBe('Expiring');
  });

  it('calls anything further out Active', () => {
    expect(keyStatus(key())).toBe('Active');
  });
});

describe('keyCounts', () => {
  it('counts expiring keys as active as well as expiring', () => {
    const counts = keyCounts([
      key(),
      key({ id: 'b', expiresAt: new Date(Date.now() + 5 * day).toISOString() }),
      key({ id: 'c', revokedAt: '2026-08-20T00:00:00.000Z' }),
    ]);

    expect(counts).toEqual({ total: 3, active: 2, expiring: 1, revoked: 1 });
  });
});

describe('replacementFor', () => {
  it('carries the scope and allowWrite a write role needs, or the mint route refuses it', () => {
    expect(replacementFor(key({ roles: ['demi-service-write'], projectScope: ['402'] }))).toEqual({
      name: 'epic-map-frontend',
      roles: ['demi-service-write'],
      projectScope: ['402'],
      allowWrite: true,
    });
  });

  it('leaves allowWrite and scope off a read-only unscoped key', () => {
    expect(replacementFor(key())).toEqual({ name: 'epic-map-frontend', roles: ['demi-service-read'] });
  });
});

describe('requests', () => {
  it('reads the key list from /admin/api-keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([key()]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listApiKeys()).resolves.toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:3000/api/admin/api-keys');
  });

  it('POSTs the mint body as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ...key(), key: 'demi_test_c02da6f1_secret' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await mintApiKey({ name: 'x', roles: ['demi-service-write'], allowWrite: true });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'x',
      roles: ['demi-service-write'],
      allowWrite: true,
    });
  });

  it('DELETEs a key by its encoded id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await revokeApiKey('ak/1');

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:3000/api/admin/api-keys/ak%2F1');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('surfaces the API error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Unknown role(s): wizard' }, 400)));

    await expect(mintApiKey({ name: 'x', roles: ['wizard'] })).rejects.toThrow('Unknown role(s): wizard');
  });
});
