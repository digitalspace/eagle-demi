import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { Feature, FeatureCollection, Geometry } from '../map/geojson';

/**
 * Administrative boundaries, in three resolutions.
 *
 * A boundary row is fetched at one of three tiers, and the cache only ever climbs: once the full
 * polygons are in hand, a screen asking for the simplified ones is answered from the cache rather
 * than throwing the detail away and fetching again.
 */

export type BoundaryLayer = 'regionalDistricts' | 'municipalities' | 'electoralDistricts';
export type BoundaryMode = 'metadata' | 'simplified' | 'full';
export type BoundaryTier = 'none' | BoundaryMode;

/** The fields this module reads off an API boundary row. */
export interface BoundaryRow {
  _id?: string;
  name?: string;
  type?: string;
  code?: string;
  geometry?: Geometry;
  simplifiedGeometry?: Geometry;
}

export interface BoundaryProperties {
  id?: string;
  name?: string;
  type?: string;
  code?: string;
}

const TIER_RANK: Record<BoundaryTier, number> = { none: 0, metadata: 1, simplified: 2, full: 3 };

const API_TYPE: Record<BoundaryLayer, string> = {
  regionalDistricts: 'Regional District',
  municipalities: 'Municipality',
  electoralDistricts: 'Electoral District',
};

const STATIC_ASSET: Record<BoundaryLayer, string> = {
  regionalDistricts: '/assets/geojson/regional_districts.geojson',
  municipalities: '/assets/geojson/municipalities.geojson',
  electoralDistricts: '/assets/geojson/electoral_districts.geojson',
};

const GEOMETRY_PARAM: Record<BoundaryMode, string> = {
  full: 'true',
  metadata: 'false',
  simplified: 'simplified',
};

/** Rows carry the resolution they were fetched at; there is no tier field to read. */
export function tierOf(rows: BoundaryRow[] | undefined | null): BoundaryTier {
  if (!rows || rows.length === 0) return 'none';
  if (rows.some((row) => row.geometry)) return 'full';
  if (rows.some((row) => row.simplifiedGeometry)) return 'simplified';
  return 'metadata';
}

/** Do these rows already answer a request for `mode`, at this resolution or a better one? */
export function covers(rows: BoundaryRow[] | undefined | null, mode: BoundaryMode): boolean {
  return TIER_RANK[tierOf(rows)] >= TIER_RANK[mode];
}

export function boundariesPath(layer: BoundaryLayer, mode: BoundaryMode): string {
  return `/boundaries?type=${encodeURIComponent(API_TYPE[layer])}&geometry=${GEOMETRY_PARAM[mode]}`;
}

/** API rows as a FeatureCollection, the shape a map source takes. */
export function toFeatureCollection(rows: BoundaryRow[]): FeatureCollection<BoundaryProperties> {
  return {
    type: 'FeatureCollection',
    features: rows.map(
      (row): Feature<BoundaryProperties> => ({
        type: 'Feature',
        properties: { id: row._id, name: row.name, type: row.type, code: row.code },
        // Null, not undefined: a metadata row is still a feature, and a missing `geometry` key is
        // not valid GeoJSON.
        geometry: row.geometry ?? row.simplifiedGeometry ?? null,
      }),
    ),
  };
}

const CACHE_KEY = 'demi_boundaries_cache';

function restore(): Record<string, BoundaryRow[]> {
  try {
    const raw = window.localStorage?.getItem(CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, BoundaryRow[]>;
  } catch {
    // A corrupt or blocked store costs a refetch, nothing more.
  }
  return {};
}

function persist(cache: Record<string, BoundaryRow[]>): void {
  try {
    const stripped: Record<string, BoundaryRow[]> = {};
    for (const [key, rows] of Object.entries(cache)) {
      // Geometry is megabytes and would blow the quota; only the names survive a reload.
      stripped[key] = rows.map(({ geometry: _g, simplifiedGeometry: _s, ...rest }) => rest);
    }
    window.localStorage?.setItem(CACHE_KEY, JSON.stringify(stripped));
  } catch {
    // Quota or private mode: the in-memory cache still works for this visit.
  }
}

let cache: Record<string, BoundaryRow[]> = restore();

export const boundaryCache = {
  get(layer: BoundaryLayer): BoundaryRow[] | undefined {
    return cache[layer];
  },
  tier(layer: BoundaryLayer): BoundaryTier {
    return tierOf(cache[layer]);
  },
  set(layer: BoundaryLayer, rows: BoundaryRow[]): void {
    cache = { ...cache, [layer]: rows };
    persist(cache);
  },
  clear(): void {
    cache = {};
    persist(cache);
  },
};

/** The build-time copy of a boundary set, or null when it is not published. */
async function loadStaticAsset(url: string): Promise<BoundaryRow[] | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const rows: unknown = await res.json();
    return Array.isArray(rows) && rows.length > 0 ? (rows as BoundaryRow[]) : null;
  } catch {
    return null;
  }
}

/**
 * Boundary rows for one layer at `mode` or better: cache, then the static asset, then the API.
 *
 * A failed read caches an empty list so the screen renders, and the next call retries.
 */
export async function loadBoundaries(
  layer: BoundaryLayer,
  mode: BoundaryMode = 'simplified',
): Promise<BoundaryRow[]> {
  const cached = boundaryCache.get(layer);
  if (cached && cached.length > 0 && covers(cached, mode)) return cached;

  const asset = await loadStaticAsset(STATIC_ASSET[layer]);
  if (asset) {
    boundaryCache.set(layer, asset);
    return asset;
  }

  try {
    const rows = await api<BoundaryRow[]>(boundariesPath(layer, mode));
    boundaryCache.set(layer, rows);
    return rows;
  } catch {
    boundaryCache.set(layer, []);
    return [];
  }
}

/** Full geometry for one named boundary, merged into the cached row. */
export async function loadBoundaryGeometry(
  layer: BoundaryLayer,
  name: string,
): Promise<BoundaryRow | null> {
  if (!name || name === 'all') return null;

  const rows = boundaryCache.get(layer) ?? [];
  const cached = rows.find((row) => (row.name ?? '').toLowerCase() === name.toLowerCase());
  if (cached?.geometry) return cached;

  try {
    const row = await api<BoundaryRow>(`/boundaries/${encodeURIComponent(name)}`);
    if (!row?.geometry) return null;

    const merged = [...rows];
    const index = merged.findIndex((b) => (b.name ?? '').toLowerCase() === name.toLowerCase());
    if (index === -1) merged.push(row);
    else merged[index] = { ...merged[index], geometry: row.geometry };
    boundaryCache.set(layer, merged);
    return row;
  } catch {
    return null;
  }
}

export function useBoundaries(layer: BoundaryLayer | null, mode: BoundaryMode = 'simplified') {
  return useQuery({
    queryKey: ['boundaries', layer, mode],
    queryFn: () => loadBoundaries(layer as BoundaryLayer, mode),
    enabled: layer !== null,
    staleTime: Infinity,
  });
}

export function useBoundaryGeometry(layer: BoundaryLayer | null, name: string | null) {
  return useQuery({
    queryKey: ['boundary', layer, name],
    queryFn: () => loadBoundaryGeometry(layer as BoundaryLayer, name as string),
    enabled: layer !== null && !!name && name !== 'all',
    staleTime: Infinity,
  });
}
