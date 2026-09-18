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
