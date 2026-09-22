import { describe, expect, it } from 'vitest';
import { MAX_LATITUDE, project, unproject } from './mercator';

// Reference values are what Leaflet's L.CRS.EPSG3857.project() returned for the Angular map.
describe('mercator', () => {
  it('projects a point to the metres the tiled world is cut in', () => {
    const { x, y } = project(-123.3656, 48.4284);

    expect(x).toBeCloseTo(-13732995.7734067, 3);
    expect(y).toBeCloseTo(6178423.5663674, 3);
  });

  it('puts the antimeridian on the edge of the square world', () => {
    expect(project(180, 0).x).toBeCloseTo(20037508.3427892, 3);
  });

  it('leaves the origin at the origin', () => {
    expect(project(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('comes back to the same longitude and latitude', () => {
    const { x, y } = project(-123.3656, 48.4284);
    const back = unproject(x, y);

    expect(back.lng).toBeCloseTo(-123.3656, 9);
    expect(back.lat).toBeCloseTo(48.4284, 9);
  });

  it('comes back to the same metres', () => {
    const { lng, lat } = unproject(-13732995.7734067, 6178423.5663674);
    const back = project(lng, lat);

    expect(back.x).toBeCloseTo(-13732995.7734067, 3);
    expect(back.y).toBeCloseTo(6178423.5663674, 3);
  });

  // The projection runs to infinity at the poles, so the world stops short of them.
  it('clamps a latitude past the world edge instead of returning infinity', () => {
    expect(project(0, 90).y).toBe(project(0, MAX_LATITUDE).y);
    expect(project(0, 90).y).toBeCloseTo(20037508.3427807, 3);
  });

  it('clamps the south edge the same way', () => {
    expect(project(0, -90).y).toBe(project(0, -MAX_LATITUDE).y);
  });
});
