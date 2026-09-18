import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boundaryCache,
  loadBoundaries,
  loadBoundaryGeometry,
  tierOf,
  toFeatureCollection,
  type BoundaryRow,
} from './boundaries';
import { api } from './client';

vi.mock('./client', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);
const fetchMock = vi.fn();

const POLYGON = { type: 'Polygon', coordinates: [] };

/** A static asset answer; `null` stands for the asset not being published. */
const assetAnswering = (rows: BoundaryRow[] | null) =>
  fetchMock.mockResolvedValue({
    ok: rows !== null,
    json: async () => rows,
  } as Response);

const apiPathsAsked = () => apiMock.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  apiMock.mockReset();
  window.localStorage.clear();
  boundaryCache.clear();
  assetAnswering(null);
});

describe('boundary tiers', () => {
  it('reads full geometry off the rows', () => {
    expect(tierOf([{ name: 'Capital', geometry: POLYGON }])).toBe('full');
  });

  it('reads simplified geometry off the rows', () => {
    expect(tierOf([{ name: 'Capital', simplifiedGeometry: POLYGON }])).toBe('simplified');
  });

  it('calls rows without any geometry metadata', () => {
    expect(tierOf([{ name: 'Capital' }])).toBe('metadata');
  });

  it('calls an empty list none', () => {
    expect(tierOf([])).toBe('none');
  });
});

describe('loadBoundaries', () => {
  it('answers a simplified request from the full geometry already held', async () => {
    const cached = [{ name: 'Capital', geometry: POLYGON }];
    boundaryCache.set('regionalDistricts', cached);

    const rows = await loadBoundaries('regionalDistricts', 'simplified');

    expect(rows).toBe(cached);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('fetches when the request asks for more than the cache holds', async () => {
    boundaryCache.set('regionalDistricts', [{ name: 'Capital' }]);
    apiMock.mockResolvedValue([{ name: 'Capital', simplifiedGeometry: POLYGON }]);

    const rows = await loadBoundaries('regionalDistricts', 'simplified');

    expect(tierOf(rows)).toBe('simplified');
  });

  it('takes the static asset before asking the API', async () => {
    const published = [{ name: 'Capital', geometry: POLYGON }];
    assetAnswering(published);

    const rows = await loadBoundaries('regionalDistricts', 'simplified');

    expect(rows).toEqual(published);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/assets/geojson/regional_districts.geojson');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('asks the API for the layer type and resolution when the asset is not published', async () => {
    apiMock.mockResolvedValue([{ name: 'Capital', simplifiedGeometry: POLYGON }]);

    await loadBoundaries('regionalDistricts', 'simplified');

    expect(apiPathsAsked()).toEqual(['/boundaries?type=Regional%20District&geometry=simplified']);
  });

  it('asks for whole geometry in full mode', async () => {
    apiMock.mockResolvedValue([]);

    await loadBoundaries('municipalities', 'full');

    expect(apiPathsAsked()).toEqual(['/boundaries?type=Municipality&geometry=true']);
  });

  it('asks for names alone in metadata mode', async () => {
    apiMock.mockResolvedValue([]);

    await loadBoundaries('electoralDistricts', 'metadata');

    expect(apiPathsAsked()).toEqual(['/boundaries?type=Electoral%20District&geometry=false']);
  });

  it('gives an empty list back when the read fails, so the map still draws', async () => {
    apiMock.mockRejectedValue(new Error('HTTP 503'));

    await expect(loadBoundaries('municipalities')).resolves.toEqual([]);
  });

  it('tries again after a failed read rather than caching the outage', async () => {
    apiMock.mockRejectedValueOnce(new Error('HTTP 503'));
    await loadBoundaries('municipalities');

    apiMock.mockResolvedValue([{ name: 'Tofino', simplifiedGeometry: POLYGON }]);
    const rows = await loadBoundaries('municipalities');

    expect(rows).toEqual([{ name: 'Tofino', simplifiedGeometry: POLYGON }]);
  });

  it('keeps geometry out of the stored copy, which has a quota', async () => {
    assetAnswering([{ name: 'Capital', code: 'CRD', geometry: POLYGON }]);

    await loadBoundaries('regionalDistricts');

    const stored = JSON.parse(window.localStorage.getItem('demi_boundaries_cache') ?? '{}');
    expect(stored.regionalDistricts).toEqual([{ name: 'Capital', code: 'CRD' }]);
  });
});

describe('loadBoundaryGeometry', () => {
  it('answers from the cached row once it carries geometry', async () => {
    const row = { name: 'Victoria-Beacon Hill', geometry: POLYGON };
    boundaryCache.set('electoralDistricts', [row]);

    await expect(loadBoundaryGeometry('electoralDistricts', 'Victoria-Beacon Hill')).resolves.toBe(
      row,
    );
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('puts fetched geometry on the row the cache already holds', async () => {
    boundaryCache.set('electoralDistricts', [{ name: 'Victoria-Beacon Hill', code: 'VBH' }]);
    apiMock.mockResolvedValue({ name: 'Victoria-Beacon Hill', geometry: POLYGON });

    await loadBoundaryGeometry('electoralDistricts', 'Victoria-Beacon Hill');

    expect(boundaryCache.get('electoralDistricts')).toEqual([
      { name: 'Victoria-Beacon Hill', code: 'VBH', geometry: POLYGON },
    ]);
  });

  it('asks nothing for the all-boundaries placeholder', async () => {
    await expect(loadBoundaryGeometry('electoralDistricts', 'all')).resolves.toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe('toFeatureCollection', () => {
  it('carries the name and code through as feature properties', () => {
    const { features } = toFeatureCollection([
      { _id: 'b1', name: 'Capital', type: 'Regional District', code: 'CRD', geometry: POLYGON },
    ]);

    expect(features[0].properties).toEqual({
      id: 'b1',
      name: 'Capital',
      type: 'Regional District',
      code: 'CRD',
    });
  });

  it('prefers the full geometry over the simplified one', () => {
    const full = { type: 'Polygon', coordinates: [[1, 2]] };
    const { features } = toFeatureCollection([
      { name: 'Capital', geometry: full, simplifiedGeometry: POLYGON },
    ]);

    expect(features[0].geometry).toBe(full);
  });

  it('gives a metadata row a null geometry, not a missing one', () => {
    const { features } = toFeatureCollection([{ name: 'Capital' }]);

    expect(features[0].geometry).toBeNull();
  });
});
