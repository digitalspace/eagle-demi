/** The slice of GeoJSON this app reads. The full spec types would be a dependency for four fields. */

export interface Geometry {
  type: string;
  coordinates: unknown;
}

export interface Feature<P = Record<string, unknown>> {
  type: 'Feature';
  properties: P;
  geometry: Geometry | null;
}

export interface FeatureCollection<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: Feature<P>[];
}

export const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Longitude, latitude. */
export type Position = [number, number];

export type BBox = [west: number, south: number, east: number, north: number];

/** Every outer ring of a Polygon or MultiPolygon. Anything else has no area to test against. */
function outerRings(geometry: Geometry | null | undefined): Position[][] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  const coordinates = geometry.coordinates as unknown[];
  if (geometry.type === 'Polygon') return coordinates.length ? [coordinates[0] as Position[]] : [];
  if (geometry.type === 'MultiPolygon') {
    return coordinates
      .map((polygon) => (polygon as Position[][])[0])
      .filter((ring): ring is Position[] => Array.isArray(ring));
  }
  return [];
}

export function bboxOfPositions(positions: Iterable<Position>): BBox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const [lng, lat] of positions) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  }
  return west === Infinity ? null : [west, south, east, north];
}

export function bboxOf(geometry: Geometry | null | undefined): BBox | null {
  return bboxOfPositions(outerRings(geometry).flat());
}

/** Ray casting against the outer rings, as the Angular screen did it: holes are not subtracted. */
export function containsPoint(geometry: Geometry | null | undefined, point: Position): boolean {
  const [x, y] = point;
  return outerRings(geometry).some((ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
}
