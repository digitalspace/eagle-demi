/**
 * Spherical Mercator (EPSG:3857), the projection web tiles are cut in.
 *
 * Same numbers Leaflet's `L.CRS.EPSG3857.project()` returned, so a WMS BBOX built here matches the
 * one the Angular map sent. proj4 would be a dependency for six lines of trigonometry.
 */

/** Earth radius the projection is defined on, in metres. */
const R = 6378137;

/** Past this the projection runs to infinity, so the square world ends here. */
export const MAX_LATITUDE = 85.0511287798;

const DEG = Math.PI / 180;

export interface MetrePoint {
  x: number;
  y: number;
}

export interface LngLat {
  lng: number;
  lat: number;
}

/** Longitude and latitude in degrees to EPSG:3857 metres. Latitude outside the world is clamped. */
export function project(lng: number, lat: number): MetrePoint {
  const clamped = Math.max(Math.min(MAX_LATITUDE, lat), -MAX_LATITUDE);
  const sin = Math.sin(clamped * DEG);
  return {
    x: R * lng * DEG,
    y: (R * Math.log((1 + sin) / (1 - sin))) / 2,
  };
}

/** EPSG:3857 metres back to longitude and latitude in degrees. */
export function unproject(x: number, y: number): LngLat {
  return {
    lng: x / (R * DEG),
    lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / DEG,
  };
}
