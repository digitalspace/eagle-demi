import { describe, expect, it } from 'vitest';
import { screenKeyOf } from './screenKey';
import { GROUPS, SCREENS, TECH } from './screens';
import pkg from '../../package.json';

describe('SCREENS', () => {
  it('gives every screen a group the sidebar renders', () => {
    const groups = SCREENS.map((screen) => screen.group).filter((group) => group !== null);

    expect(new Set(groups)).toEqual(new Set(GROUPS));
  });

  it('names the two generated-summary screens for what they summarise', () => {
    const labelOf = (path: string) => SCREENS.find((screen) => screen.path === path)?.label;

    expect(labelOf('/summary')).toBe('AI Search Summary');
    expect(labelOf('/projects')).toBe('AI Project Summary');
  });

  it('describes how every screen is built', () => {
    const missing = SCREENS.filter((screen) => !TECH[screen.key]);

    expect(missing).toEqual([]);
  });

  it('credits the map screen to the map library the app ships', () => {
    const chips = TECH.map.chips.join(' | ');

    expect(Object.keys(pkg.dependencies)).toContain('maplibre-gl');
    expect(chips).toContain('MapLibre');
    expect(chips).toContain('Esri tiles');
    expect(chips).not.toMatch(/Leaflet|OpenStreetMap/);
  });
});

describe('screenKeyOf', () => {
  it('reads the screen out of its own path', () => {
    expect(screenKeyOf('/workspace')).toBe('me');
    expect(screenKeyOf('/keys')).toBe('keys');
  });

  // A screen owns every URL under its path, so a deep link is still that screen.
  it('treats a URL under a screen path as that screen', () => {
    expect(screenKeyOf('/projects/272')).toBe('project');
  });

  it('calls the root the map, which is where an unknown path lands', () => {
    expect(screenKeyOf('/')).toBe('map');
  });
});
