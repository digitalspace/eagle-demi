import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as maplibre from 'maplibre-gl';

vi.mock('@vis.gl/react-maplibre', async () =>
  (await import('./maplibre-test-stub')).mapLibreStub(),
);

const { MapControls, DEFAULT_BASEMAP, basemapSource, createCredit } = await import('./basemaps');
const { cornerControls } = await import('./maplibre-test-stub');

const picker = () => screen.getByRole('button', { name: 'Base map' });

function renderControls(onBasemapChange = vi.fn()) {
  render(<MapControls basemap={DEFAULT_BASEMAP} onBasemapChange={onBasemapChange} />);
  return onBasemapChange;
}

describe('MapControls base map picker', () => {
  it('stays shut until the button is pressed', async () => {
    renderControls();

    expect(screen.queryByRole('radio', { name: 'World Imagery' })).toBeNull();
    expect(picker()).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(picker());

    expect(picker()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('radio', { name: DEFAULT_BASEMAP })).toBeChecked();
  });

  it('reports the base map that was picked', async () => {
    const onBasemapChange = renderControls();

    await userEvent.click(picker());
    await userEvent.click(screen.getByRole('radio', { name: 'World Imagery' }));

    expect(onBasemapChange).toHaveBeenCalledWith('World Imagery');
  });

  it('closes on Escape and hands focus back to the button', async () => {
    renderControls();

    await userEvent.click(picker());
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('radio', { name: 'World Imagery' })).toBeNull();
    expect(picker()).toHaveFocus();
  });

  // One shared name would join both maps' radios into one group, so picking in one unticks the other.
  it('gives each map its own radio group', async () => {
    render(
      <>
        <MapControls basemap={DEFAULT_BASEMAP} onBasemapChange={vi.fn()} />
        <MapControls basemap={DEFAULT_BASEMAP} onBasemapChange={vi.fn()} />
      </>,
    );
    const [first, second] = screen.getAllByRole('button', { name: 'Base map' });

    await userEvent.click(first);
    const firstName = screen.getByRole('radio', { name: DEFAULT_BASEMAP }).getAttribute('name');
    await userEvent.click(second);
    const secondName = screen.getByRole('radio', { name: DEFAULT_BASEMAP }).getAttribute('name');

    expect(firstName).not.toBe(secondName);
  });

  it('closes on a press outside it', async () => {
    renderControls();

    await userEvent.click(picker());
    await userEvent.click(document.body);

    expect(screen.queryByRole('radio', { name: 'World Imagery' })).toBeNull();
  });
});

describe('MapControls attribution', () => {
  it('puts the base map credit lowest in the corner, under the zoom and scale', () => {
    renderControls();

    expect(cornerControls('bottom-right').at(-1)).toBe('attribution');
  });
});

/** Just enough map for MapLibre's own AttributionControl: a desktop-wide canvas and one base map. */
function creditOnDesktopMap() {
  const handlers: Record<string, ((event: object) => void)[]> = {};
  const tileManagers: Record<string, object> = {};
  const map = {
    style: { tileManagers },
    _getUIString: () => 'Toggle attribution',
    getCanvasContainer: () => ({ offsetWidth: 1440 }),
    on: (type: string, handler: (event: object) => void) => {
      (handlers[type] ??= []).push(handler);
    },
    off: vi.fn(),
  };
  const credit = createCredit({ mapLib: maplibre }).onAdd(map as never);
  document.body.append(credit);
  onTestFinished(() => credit.remove());

  // As the real map does: the base map's tiles, and so its credit, arrive after the control.
  tileManagers['basemap'] = { used: true, getSource: () => ({ attribution: 'Sources: Esri' }) };
  handlers['sourcedata']?.forEach((handler) => handler({ dataType: 'source', sourceDataType: 'metadata' }));
  return credit;
}

describe('createCredit', () => {
  it('shows only the "i" once the credit arrives, even on a wide map', () => {
    const credit = creditOnDesktopMap();

    expect(credit).toHaveClass('maplibregl-compact');
    expect(credit).not.toHaveClass('maplibregl-compact-show');
    expect(credit).toHaveTextContent('Sources: Esri');
  });

  it('opens the credit on a press of the "i"', async () => {
    const credit = creditOnDesktopMap();

    await userEvent.click(within(credit).getByLabelText('Toggle attribution'));

    expect(credit).toHaveClass('maplibregl-compact-show');
  });
});

describe('basemapSource attribution', () => {
  // The providers each Esri service names in its own copyrightText.
  it.each([
    ['Light Gray', ['Esri', 'HERE', 'Garmin', 'OpenStreetMap contributors']],
    ['World Topographic', ['Esri', 'Intermap', 'GEBCO', 'USGS', 'NRCAN', 'OpenStreetMap contributors']],
    ['World Imagery', ['Esri', 'Vantor', 'Earthstar Geographics']],
  ])('credits %s with its own data providers', (name, providers) => {
    const { attribution } = basemapSource(name);

    for (const provider of providers) expect(attribution).toContain(provider);
  });

  it('gives every base map a different credit', () => {
    const credits = ['Light Gray', 'World Topographic', 'World Imagery'].map(
      (name) => basemapSource(name).attribution,
    );

    expect(new Set(credits).size).toBe(3);
  });
});
