import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@vis.gl/react-maplibre', async () =>
  (await import('./maplibre-test-stub')).mapLibreStub(),
);

const { default: MiniMap } = await import('./MiniMap');
// The namespace, not the binding: `mapProps` is set as the map mounts.
const stub = await import('./maplibre-test-stub');
const { fakeMap, sourceTilesFor } = stub;
const { DEFAULT_BASEMAP, WORKER_URL, basemapSource } = await import('./basemaps');

const SKEENA = [
  [-127, 54],
  [-126, 54],
  [-126, 55],
];
const CAPITAL = [
  [-124, 48],
  [-123, 48],
  [-123, 49],
];

const lastFitBounds = () => fakeMap.fitBounds.mock.calls.at(-1)?.[0];

beforeEach(() => {
  fakeMap.reset();
});

describe('MiniMap', () => {
  // maplibre-gl works out its own worker URL from its module URL, which the built chunk has not got.
  it('hands the map the bundled worker', () => {
    render(<MiniMap ring={SKEENA} />);

    expect(stub.mapProps?.['workerUrl']).toBe(WORKER_URL);
  });

  it('draws the ground from the shared basemap source', () => {
    render(<MiniMap ring={SKEENA} />);

    expect(sourceTilesFor('mini-basemap')).toEqual(basemapSource(DEFAULT_BASEMAP).tiles);
  });

  it('credits the tiles in a control small enough for a thumbnail', () => {
    render(<MiniMap ring={SKEENA} />);

    expect(screen.getByTestId('attribution').dataset['compact']).toBe('true');
  });

  it('frames the area it is handed, and the next one', () => {
    const { rerender } = render(<MiniMap ring={SKEENA} />);
    expect(lastFitBounds()).toEqual([
      [-127, 54],
      [-126, 55],
    ]);

    rerender(<MiniMap ring={CAPITAL} />);

    expect(lastFitBounds()).toEqual([
      [-124, 48],
      [-123, 49],
    ]);
  });
});
