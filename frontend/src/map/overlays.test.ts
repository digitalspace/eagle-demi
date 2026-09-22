import { describe, expect, it, vi } from 'vitest';

vi.mock('@vis.gl/react-maplibre', async () =>
  (await import('./maplibre-test-stub')).mapLibreStub(),
);

const { BOUNDARY_STYLES, fillPaint, linePaint } = await import('./overlays');

describe('boundary paint', () => {
  // The public project map draws the same regions in the BC Gov blue, and they have to read alike.
  it('paints the environmental regions in the shade the public map uses', () => {
    expect(fillPaint(BOUNDARY_STYLES.regions, false)).toMatchObject({ 'fill-color': '#003366' });
    expect(linePaint(BOUNDARY_STYLES.regions, false)).toMatchObject({ 'line-color': '#003366' });
  });

  it('holds the region edges back, so the pins over them stay readable', () => {
    expect(linePaint(BOUNDARY_STYLES.regions, false)).toMatchObject({ 'line-opacity': 0.5 });
  });

  it.each(['regionalDistricts', 'municipalities', 'electoralDistricts'] as const)(
    'draws the %s edges solid while nothing is picked',
    (layer) => {
      expect(linePaint(BOUNDARY_STYLES[layer], false)).toMatchObject({ 'line-opacity': 1 });
    },
  );
});
