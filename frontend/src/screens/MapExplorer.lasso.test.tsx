import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Project } from '../api/types';
import { renderScreen } from '../test-query';
import { json, noContent, requests } from '../test-http';
import { ANONYMOUS_SESSION, type Session } from '../session/session';
import { setPendingLasso } from '../map/pending-lasso';

vi.mock('@vis.gl/react-maplibre', async () =>
  (await import('../map/maplibre-test-stub')).mapLibreStub(),
);

vi.mock('../config', () => ({ config: () => ({ API_PATH: '/api', KEYCLOAK_ENABLED: false }) }));

vi.mock('../api/keycloak', () => ({
  getToken: () => 'staff-token',
  refreshToken: async () => true,
  getSessionClaims: () => null,
}));

const useProjectsMock = vi.fn();
vi.mock('../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/projects')>()),
  useProjects: (query: string) => useProjectsMock(query),
}));

const useDocumentsMock = vi.fn();
vi.mock('../api/documents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/documents')>()),
  useDocuments: (query: string) => useDocumentsMock(query),
}));

const { MapExplorer } = await import('./MapExplorer');
const { fakeMap, drawStroke, cancelStroke, sourceDataFor, VIEWPORT_SIZE } = await import(
  '../map/maplibre-test-stub'
);
const { LASSO_SOURCE_ID } = await import('../map/lasso');

function project(over: Partial<Project> & { id: string | number }): Project {
  return {
    name: `Project ${over.id}`,
    gatingState: 'admitted',
    sector: 'Mines',
    status: 'Active',
    region: 'Skeena',
    proponent: 'Acme',
    centroid: [-124, 50],
    ...over,
  } as Project;
}

const MINE = project({ id: 1, name: 'Copper Ridge' });
const ENERGY = project({ id: 2, name: 'Alder Wind', centroid: [-120, 56] });
/** No centroid at all: a drawn area has nothing to test it against. */
const NOWHERE = project({ id: 3, name: 'Ghost Creek', centroid: undefined });

/**
 * The stub's viewport is the whole of BC over a 1000x1000 box, so these pixels are a stroke around
 * Copper Ridge's centroid and nowhere near Alder Wind's.
 */
const AROUND_MINE: [number, number][] = [
  [550, 780],
  [650, 780],
  [650, 880],
  [550, 880],
];

const SKEENA = {
  slug: 'skeena',
  name: 'Skeena',
  ring: [
    [-126, 53],
    [-125, 53],
    [-125, 54],
    [-126, 54],
  ],
  updatedAt: '2026-09-03T00:00:00Z',
};

const SIGNED_IN: Session = { ...ANONYMOUS_SESSION, settled: true, authenticated: true };

/** Answers by path: the screen's reads race, and an ordered stub would swap them. */
function serve(routes: Record<string, () => Response> = {}) {
  const fetchMock = vi.fn(async (...args: unknown[]) => {
    const path = new URL(String(args[0]), 'http://localhost').pathname;
    // The boundary and layer reads all answer with lists; only the named routes carry objects.
    return routes[path]?.() ?? json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const withAreas = (...lassos: typeof SKEENA[]) =>
  serve({ '/api/me/data': () => json({ prefs: null, lassos, queries: [] }) });

async function mount(session: Session = SIGNED_IN) {
  const view = renderScreen(<MapExplorer />, session);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

const rail = () => screen.getByRole('listbox', { name: 'Projects' });
const rows = () => within(rail()).queryAllByRole('option').map((row) => row.textContent);
const chips = () =>
  screen.queryAllByRole('button', { name: 'Remove filter' }).map((chip) => chip.textContent);
const lassoButton = () => screen.getByRole('button', { name: 'Lasso' });
const container = () => fakeMap.getContainer();

/** The one lasso source's polygon ring, as the map is holding it. */
function drawnRing(): number[][] | null {
  const geometry = sourceDataFor(LASSO_SOURCE_ID)?.features[0]?.geometry;
  return geometry?.type === 'Polygon' ? geometry.coordinates[0] : null;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  fakeMap.reset();
  vi.unstubAllGlobals();
  serve();
  useProjectsMock.mockReturnValue({
    data: { projects: [MINE, ENERGY], matchCount: 2 },
    isPending: false,
    isError: false,
  });
  useDocumentsMock.mockReturnValue({ data: [] });
});

afterEach(() => vi.clearAllMocks());

describe('MapExplorer lasso', () => {
  it('takes the map off dragging while armed and gives it back on disarm', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(lassoButton());
    expect(lassoButton()).toHaveAttribute('aria-pressed', 'true');
    expect(fakeMap.dragPan.disable).toHaveBeenCalled();
    expect(container().style.touchAction).toBe('none');
    expect(container().style.cursor).toBe('crosshair');

    await user.click(lassoButton());
    expect(lassoButton()).toHaveAttribute('aria-pressed', 'false');
    expect(fakeMap.dragPan.enable).toHaveBeenCalled();
    expect(container().style.touchAction).toBe('');
  });

  it('keeps a drawn area to the projects its centroid falls inside', async () => {
    const user = userEvent.setup();
    useProjectsMock.mockReturnValue({
      data: { projects: [MINE, ENERGY, NOWHERE], matchCount: 3 },
      isPending: false,
      isError: false,
    });
    await mount();
    expect(rows()).toHaveLength(3);

    await user.click(lassoButton());
    act(() => drawStroke(AROUND_MINE));

    expect(rows()).toEqual([expect.stringContaining('Copper Ridge')]);
    expect(chips()).toEqual([expect.stringContaining('Lasso area')]);
  });

  it('draws the stroke while it is being made and the committed ring after', async () => {
    const user = userEvent.setup();
    await mount();
    expect(drawnRing()).toBeNull();

    await user.click(lassoButton());
    act(() => drawStroke(AROUND_MINE));

    // Closed: the four drawn points plus the repeat of the first.
    expect(drawnRing()).toHaveLength(AROUND_MINE.length + 1);
  });

  it('commits nothing from a stroke with no interior', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(lassoButton());
    act(() => drawStroke(AROUND_MINE.slice(0, 3)));

    expect(chips()).toEqual([]);
    expect(rows()).toHaveLength(2);
  });

  it('commits nothing when the gesture is cancelled mid-stroke', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(lassoButton());
    act(() => {
      container().dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 550, clientY: 780 }),
      );
      cancelStroke();
    });

    expect(drawnRing()).toBeNull();
    expect(chips()).toEqual([]);
  });

  it('drops the area from the chip and from the map', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(lassoButton());
    act(() => drawStroke(AROUND_MINE));
    expect(rows()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Remove filter' }));

    expect(chips()).toEqual([]);
    expect(drawnRing()).toBeNull();
    expect(rows()).toHaveLength(2);
  });

  it('drops the area with Clear all, alongside every other filter', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(lassoButton());
    act(() => drawStroke(AROUND_MINE));
    await user.click(lassoButton());

    await user.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(chips()).toEqual([]);
    expect(rows()).toHaveLength(2);
  });
});

describe('MapExplorer Escape order', () => {
  it('gives Escape to the armed lasso first, then to the selection', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(within(rail()).getByRole('option', { name: /Copper Ridge/ }));
    await user.click(lassoButton());
    act(() => drawStroke(AROUND_MINE));
    expect(chips()).toHaveLength(1);

    await user.keyboard('{Escape}');
    expect(chips()).toEqual([]);
    expect(lassoButton()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('region', { name: 'Copper Ridge' })).toBeTruthy();

    await user.keyboard('{Escape}');
    // The card outlives the deselect by its exit animation.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Copper Ridge' })).toBeNull());
  });

  it('closes an open panel before it reaches the selection', async () => {
    const user = userEvent.setup();
    withAreas(SKEENA);
    await mount();

    await user.click(within(rail()).getByRole('option', { name: /Copper Ridge/ }));
    await user.click(screen.getByRole('button', { name: 'Saved areas' }));
    expect(screen.getByRole('button', { name: 'Saved areas' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Saved areas' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('region', { name: 'Copper Ridge' })).toBeTruthy();

    await user.keyboard('{Escape}');
    // The card outlives the deselect by its exit animation.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Copper Ridge' })).toBeNull());
  });
});

describe('MapExplorer saving an area', () => {
  async function drawn(user: ReturnType<typeof userEvent.setup>) {
    await user.click(lassoButton());
    act(() => drawStroke(AROUND_MINE));
    await user.click(lassoButton());
  }

  it('offers nothing to save until an area is drawn', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: 'Save this area' })).toBeNull();
  });

  it('holds Save shut until the area has a name, then sends the ring', async () => {
    const user = userEvent.setup();
    const fetchMock = withAreas();
    await mount();
    await drawn(user);

    await user.click(screen.getByRole('button', { name: 'Save this area' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText('Name this area'), 'Copper basin');
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() =>
      expect(requests(fetchMock)).toContain(`PUT ${window.location.origin}/api/me/lassos`),
    );
    const put = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    const body = JSON.parse(String((put?.[1] as RequestInit).body)) as {
      name: string;
      ring: number[][];
    };
    expect(body.name).toBe('Copper basin');
    expect(body.ring).toHaveLength(AROUND_MINE.length);

    // The name takes over the chip, and the form closes behind it.
    await waitFor(() => expect(chips()).toEqual([expect.stringContaining('Copper basin')]));
    expect(screen.getByRole('button', { name: 'Save this area' })).toBeTruthy();
  });

  it('says why a refused save failed and keeps the drawn area', async () => {
    const user = userEvent.setup();
    serve({
      '/api/me/data': () => json({ prefs: null, lassos: [], queries: [] }),
      '/api/me/lassos': () => json({ error: 'Name already used' }, 409),
    });
    await mount();
    await drawn(user);

    await user.click(screen.getByRole('button', { name: 'Save this area' }));
    await user.type(screen.getByLabelText('Name this area'), 'Copper basin');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Name already used')).toBeTruthy();
    expect(chips()).toEqual([expect.stringContaining('Lasso area')]);
  });

  it('cancelling leaves the area and forgets the half-typed name', async () => {
    const user = userEvent.setup();
    withAreas();
    await mount();
    await drawn(user);

    await user.click(screen.getByRole('button', { name: 'Save this area' }));
    await user.type(screen.getByLabelText('Name this area'), 'Half');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Save this area' }));
    expect(screen.getByLabelText('Name this area')).toHaveValue('');
    expect(chips()).toEqual([expect.stringContaining('Lasso area')]);
  });
});

describe('MapExplorer saved areas panel', () => {
  it('applies a saved area with its name and closes', async () => {
    const user = userEvent.setup();
    withAreas(SKEENA);
    await mount();

    await user.click(screen.getByRole('button', { name: 'Saved areas' }));
    await user.click(await screen.findByRole('button', { name: 'Skeena' }));

    expect(chips()).toEqual([expect.stringContaining('Skeena')]);
    expect(drawnRing()).toHaveLength(SKEENA.ring.length + 1);
    expect(screen.getByRole('button', { name: 'Saved areas' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('deletes a saved area by its slug', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const path = new URL(String(args[0]), 'http://localhost').pathname;
      if (path === '/api/me/data') return json({ prefs: null, lassos: [SKEENA], queries: [] });
      return noContent();
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();

    await user.click(screen.getByRole('button', { name: 'Saved areas' }));
    await user.click(await screen.findByRole('button', { name: 'Delete Skeena' }));

    await waitFor(() =>
      expect(requests(fetchMock)).toContain(`DELETE ${window.location.origin}/api/me/lassos/skeena`),
    );
  });

  it('says what to do when the account has no areas yet', async () => {
    const user = userEvent.setup();
    withAreas();
    await mount();

    await user.click(screen.getByRole('button', { name: 'Saved areas' }));

    expect(
      await screen.findByText('Draw an area with the lasso, then save it.'),
    ).toBeTruthy();
  });

  it('shows a signed-out visitor neither the panel nor the save form', async () => {
    const user = userEvent.setup();
    await mount(ANONYMOUS_SESSION);

    expect(screen.queryByRole('button', { name: 'Saved areas' })).toBeNull();

    await user.click(lassoButton());
    act(() => drawStroke(AROUND_MINE));

    // The area still filters; only keeping it needs an account.
    expect(chips()).toEqual([expect.stringContaining('Lasso area')]);
    expect(screen.queryByRole('button', { name: 'Save this area' })).toBeNull();
  });
});

describe('MapExplorer lasso arriving before the map', () => {
  it('draws an area handed over on the way here and fits the camera to it', async () => {
    setPendingLasso({ ring: SKEENA.ring, label: 'Skeena' });
    await mount();

    expect(chips()).toEqual([expect.stringContaining('Skeena')]);
    expect(drawnRing()).toHaveLength(SKEENA.ring.length + 1);
    expect(fakeMap.fitBounds).toHaveBeenCalledWith(
      [
        [-126, 53],
        [-125, 54],
      ],
      expect.objectContaining({ padding: 30, essential: true }),
    );
  });

  it('is consumed once, so a later visit opens on a clean map', async () => {
    setPendingLasso({ ring: SKEENA.ring, label: 'Skeena' });
    const first = await mount();
    expect(chips()).toHaveLength(1);
    first.unmount();

    await mount();
    expect(chips()).toEqual([]);
  });
});

/** Guards the pixel maths the stroke fixtures depend on. */
describe('the fake viewport', () => {
  it('puts the stroke around Copper Ridge and not around Alder Wind', () => {
    const at = ([x, y]: [number, number]) => fakeMap.unproject([x, y]);
    expect(at([600, 833]).lng).toBeCloseTo(-124, 1);
    expect(at([600, 833]).lat).toBeCloseTo(50, 1);
    expect(VIEWPORT_SIZE).toBe(1000);
  });
});
