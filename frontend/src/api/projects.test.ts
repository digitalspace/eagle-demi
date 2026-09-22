import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { json, respond, urlOf } from '../test-http';
import { queryWrapper } from '../test-query';
import { BC_CENTRE, mapProject, parseCentroid, useProjects } from './projects';
import type { RawProject } from './types';

vi.mock('./keycloak', () => ({
  getToken: () => 'staff-token',
  refreshToken: async () => true,
}));

beforeEach(async () => {
  respond();
  window.__env = { API_PATH: '/api', API_LOCATION: '' };
  const { initConfig } = await import('../config');
  await initConfig();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__env;
});

describe('parseCentroid', () => {
  it('keeps a BC coordinate already in [lon, lat]', () => {
    expect(parseCentroid([-123.4, 48.6])).toEqual([-123.4, 48.6]);
  });

  it('reads the GeoJSON object shape', () => {
    expect(parseCentroid({ coordinates: [-123.4, 48.6] })).toEqual([-123.4, 48.6]);
  });

  it('swaps a pair stored as [lat, lon]', () => {
    expect(parseCentroid([54.2, -125.6])).toEqual([-125.6, 54.2]);
  });

  it('restores a longitude that lost its sign', () => {
    expect(parseCentroid([123.4, 48.6])).toEqual([-123.4, 48.6]);
  });

  it('falls back to the centre of BC for a missing or unusable centroid', () => {
    expect(parseCentroid(null)).toEqual(BC_CENTRE);
    expect(parseCentroid([Number.NaN, 4])).toEqual(BC_CENTRE);
    expect(parseCentroid([1, 2, 3])).toEqual(BC_CENTRE);
  });

  it('falls back rather than placing a project outside BC', () => {
    expect(parseCentroid([-73.5, 45.5])).toEqual(BC_CENTRE);
  });
});

describe('mapping a project row', () => {
  it('carries the identifiers and marks a published row admitted', () => {
    const row = mapProject({ _id: 'abc', id: '42', name: 'Sample Ridge', isPublished: true });

    expect(row).toMatchObject({ id: '42', legacyEagleId: 'abc', gatingState: 'admitted' });
  });

  it('marks an unpublished row staged', () => {
    expect(mapProject({ _id: 'abc', isPublished: false }).gatingState).toBe('staged');
  });

  it('names an unnamed row rather than rendering blank', () => {
    expect(mapProject({ _id: 'abc' }).name).toBe('Unnamed Project');
  });

  it('prefers the row sector, falling back to the metadata type', () => {
    const fromMetadata = mapProject({
      _id: 'a',
      sector: 'Other',
      metadata: { trackAttributes: { type_name: 'Marine Port' } },
    });

    expect(mapProject({ _id: 'a', sector: 'Mining' }).sector).toBe('Mining');
    expect(fromMetadata.sector).toBe('Marine Port');
  });

  it('leaves a description empty rather than inventing one', () => {
    expect(mapProject({ _id: 'a', name: 'Sample Ridge Wind Farm' }).description).toBe('');
    expect(mapProject({ _id: 'a', description: 'No project description provided.' }).description).toBe('');
  });

  it('keeps server markup only for a field it still describes', () => {
    const kept = mapProject({
      _id: 'a',
      name: 'Sample Ridge',
      description: 'A real description.',
      highlighted: { name: '<mark>Sample</mark> Ridge', description: 'A <mark>real</mark> description.' },
    });
    const dropped = mapProject({
      _id: 'a',
      name: 'Sample Ridge',
      description: 'No project description provided.',
      highlighted: { name: '<mark>Sample</mark> Ridge', description: '<mark>No</mark> project' },
    });

    expect(kept.highlighted).toEqual({
      name: '<mark>Sample</mark> Ridge',
      description: 'A <mark>real</mark> description.',
    });
    // The description was replaced, so marking inside it would point at text we wrote.
    expect(dropped.highlighted?.description).toBe('');
  });

  it('never invents a certificate, and tells absent from unreported', () => {
    expect(mapProject({ _id: 'a', eaCertificate: 'S00-01' }).eaCertificate).toBe('S00-01');
    expect(mapProject({ _id: 'a', eaCertificate: null }).eaCertificate).toBeNull();
    expect(mapProject({ _id: 'a' }).eaCertificate).toBeUndefined();
  });

  it('reads a proponent from either shape', () => {
    expect(mapProject({ _id: 'a', proponent: { name: 'Sample Energy' } }).proponent).toBe('Sample Energy');
    expect(mapProject({ _id: 'a', proponent: 'Example Aggregates' }).proponent).toBe('Example Aggregates');
    expect(mapProject({ _id: 'a' }).proponent).toBe('Proponent Organization');
  });
});

describe('useProjects', () => {
  it('maps the corpus and reports the index-wide total', async () => {
    const rows: RawProject[] = [{ _id: 'a', id: '1', name: 'Sample Ridge', isPublished: true }];
    respond(json([{ searchResults: rows, count: 91 }]));

    const { result } = renderHook(() => useProjects(''), { wrapper: queryWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.matchCount).toBe(91);
    expect(result.current.data?.projects[0]).toMatchObject({ id: '1', name: 'Sample Ridge' });
  });

  // A 400 rather than a 503: the hook retries a 503 twice with a real delay, which is asserted
  // against the retry predicate in search.test.ts instead of waited out here.
  it('reports a failure rather than answering with an empty corpus', async () => {
    respond(json({ error: 'unknown parameter' }, 400));

    const { result } = renderHook(() => useProjects(''), { wrapper: queryWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('reads each query separately', async () => {
    const fetchMock = respond(
      json([{ searchResults: [], count: 0 }]),
      json([{ searchResults: [], count: 0 }]),
    );
    const wrapper = queryWrapper();

    const first = renderHook(() => useProjects('gold'), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    const second = renderHook(() => useProjects('coal'), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(urlOf(fetchMock.mock.calls[0]!)).toContain('keywords=gold');
    expect(urlOf(fetchMock.mock.calls[1]!)).toContain('keywords=coal');
  });
});
