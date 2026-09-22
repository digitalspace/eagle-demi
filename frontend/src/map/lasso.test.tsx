import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';

vi.mock('@vis.gl/react-maplibre', async () =>
  (await import('./maplibre-test-stub')).mapLibreStub(),
);

const { Map: MapGL } = await import('@vis.gl/react-maplibre');
const { fakeMap } = await import('./maplibre-test-stub');
const { LASSO_MAX_POINTS, closeRing, decimate, lassoCollection, useLassoDraw } = await import(
  './lasso'
);

type MapHandle = Parameters<typeof useLassoDraw>[0];

/** The screen in miniature: an armed lasso over a map that carries a control of its own. */
function Harness({ onCommit }: { onCommit: (ring: number[][]) => void }) {
  const mapRef = useRef<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const stroke = useLassoDraw(mapRef as MapHandle, true, loaded, () => undefined, onCommit);

  return (
    <MapGL ref={mapRef as never} onLoad={() => setLoaded(true)}>
      <button type="button" className="maplibregl-ctrl">
        Zoom in
      </button>
      <span data-testid="preview">{stroke ? stroke.length : 'none'}</span>
    </MapGL>
  );
}

const pointer = (type: string, target: Element, [x, y]: [number, number]) =>
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }),
  );

const preview = () => screen.getByTestId('preview').textContent;

beforeEach(() => {
  fakeMap.reset();
});

describe('closeRing', () => {
  it('repeats the first point so the polygon closes', () => {
    expect(closeRing([[0, 0], [1, 0], [1, 1]])).toEqual([[0, 0], [1, 0], [1, 1], [0, 0]]);
  });

  it('has nothing to close below two points', () => {
    expect(closeRing([[0, 0]])).toBeNull();
    expect(closeRing([])).toBeNull();
  });

  it('draws no shape for a ring that cannot close', () => {
    expect(lassoCollection([[0, 0]], true).features).toEqual([]);
  });
});

describe('decimate', () => {
  it('leaves a ring the server will take alone', () => {
    const ring = Array.from({ length: 10 }, (_, i) => [i, i]);

    expect(decimate(ring)).toBe(ring);
  });

  it('thins a longer stroke to the server limit, keeping both ends', () => {
    const ring = Array.from({ length: 1200 }, (_, i) => [i, i]);

    const thinned = decimate(ring);

    expect(thinned).toHaveLength(LASSO_MAX_POINTS);
    expect(thinned[0]).toEqual([0, 0]);
    expect(thinned[thinned.length - 1]).toEqual([1199, 1199]);
  });
});

describe('useLassoDraw', () => {
  it('leaves a press on a map control to the control', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const control = screen.getByRole('button', { name: 'Zoom in' });

    act(() => {
      // Long enough to be a committable area, had the press started a stroke at all.
      pointer('pointerdown', control, [100, 100]);
      for (const step of [200, 300, 400, 500]) {
        pointer('pointermove', fakeMap.getContainer(), [step, step]);
      }
      pointer('pointerup', fakeMap.getContainer(), [500, 500]);
    });

    expect(preview()).toBe('none');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits a stroke no longer than the server takes', async () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const container = fakeMap.getContainer();

    act(() => {
      pointer('pointerdown', container, [10, 10]);
      for (let step = 0; step < 900; step++) pointer('pointermove', container, [10 + step, 300]);
      pointer('pointerup', container, [910, 300]);
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toHaveLength(LASSO_MAX_POINTS);
  });

  it('shows the stroke it has so far once the frame lands', async () => {
    render(<Harness onCommit={vi.fn()} />);
    const container = fakeMap.getContainer();

    act(() => {
      pointer('pointerdown', container, [10, 10]);
      pointer('pointermove', container, [20, 20]);
      pointer('pointermove', container, [30, 30]);
    });

    await waitFor(() => expect(preview()).toBe('3'));
  });

  it('gives the pointer back when the gesture is cancelled', () => {
    render(<Harness onCommit={vi.fn()} />);
    const container = fakeMap.getContainer();

    act(() => {
      pointer('pointerdown', container, [10, 10]);
    });
    expect(container.hasPointerCapture(1)).toBe(true);

    act(() => {
      container.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
    });

    expect(container.hasPointerCapture(1)).toBe(false);
    expect(preview()).toBe('none');
  });
});
