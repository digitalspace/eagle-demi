import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@vis.gl/react-maplibre', async () =>
  (await import('./maplibre-test-stub')).mapLibreStub(),
);

const { MapControls, DEFAULT_BASEMAP } = await import('./basemaps');

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

  it('closes on a press outside it', async () => {
    renderControls();

    await userEvent.click(picker());
    await userEvent.click(document.body);

    expect(screen.queryByRole('radio', { name: 'World Imagery' })).toBeNull();
  });
});
