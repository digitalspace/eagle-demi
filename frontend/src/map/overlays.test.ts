import { describe, expect, it, vi } from 'vitest';

vi.mock('@vis.gl/react-maplibre', async () =>
  (await import('./maplibre-test-stub')).mapLibreStub(),
);

const { BOUNDARY_STYLES, fillPaint, linePaint } = await import('./overlays');

interface ShapeState {
  hover?: boolean;
  selected?: boolean;
}

/** What a paint value comes to for one shape: the `case`/`feature-state` subset these paints use. */
function paintFor(value: unknown, state: ShapeState): unknown {
  if (!Array.isArray(value)) return value;
  const [op, ...args] = value as [string, ...unknown[]];
  if (op === 'feature-state') return state[args[0] as keyof ShapeState];
  if (op === 'boolean') return paintFor(args[0], state) ?? args[1];
  if (op !== 'case') throw new Error(`unhandled expression ${op}`);
  for (let i = 0; i + 1 < args.length; i += 2) {
    if (paintFor(args[i], state)) return paintFor(args[i + 1], state);
  }
  return paintFor(args[args.length - 1], state);
}

const lineOpacity = (layer: keyof typeof BOUNDARY_STYLES, state: ShapeState = {}) =>
  paintFor(linePaint(BOUNDARY_STYLES[layer], false)?.['line-opacity'], state);

describe('boundary paint', () => {
  // The public project map draws the same regions in the BC Gov blue, and they have to read alike.
  it('paints the environmental regions in the shade the public map uses', () => {
    expect(fillPaint(BOUNDARY_STYLES.regions, false)).toMatchObject({ 'fill-color': '#003366' });
    expect(linePaint(BOUNDARY_STYLES.regions, false)).toMatchObject({ 'line-color': '#003366' });
  });

  it('holds the region edges back, so the pins over them stay readable', () => {
    expect(lineOpacity('regions')).toBe(0.5);
  });

  it('draws a hovered region edge at full strength, so it holds against the darker hover fill', () => {
    expect(lineOpacity('regions', { hover: true })).toBe(1);
  });

  it.each(['regionalDistricts', 'municipalities', 'electoralDistricts'] as const)(
    'draws the %s edges solid while nothing is picked',
    (layer) => {
      expect(lineOpacity(layer)).toBe(1);
    },
  );
});
