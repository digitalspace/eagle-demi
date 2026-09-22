import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@vis.gl/react-maplibre', async () =>
  (await import('./maplibre-test-stub')).mapLibreStub(),
);

const { MapControls, DEFAULT_BASEMAP, basemapSource } = await import('./basemaps');

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
