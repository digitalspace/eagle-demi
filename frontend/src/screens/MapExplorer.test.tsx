import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Document, Project } from '../api/types';
import { CAMERA_FIT, CAMERA_FLY, CAMERA_PAN } from '../map/map-state';
import { renderScreen } from '../test-query';
import { stubNarrow } from '../test-setup';

vi.mock('@vis.gl/react-maplibre', async () =>
  (await import('../map/maplibre-test-stub')).mapLibreStub(),
);

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

const navigateMock = vi.fn();
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigateMock,
}));

const { MapExplorer } = await import('./MapExplorer');
// Namespace, not a destructured binding: `mapProps` is reassigned on every commit.
const stub = await import('../map/maplibre-test-stub');
const { fakeMap } = stub;

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

const MINE = project({ id: 1, name: 'Copper Ridge', sector: 'Mines', region: 'Skeena' });
const ENERGY = project({
  id: 2,
  name: 'Alder Wind',
  sector: 'Energy',
  region: 'Peace',
  centroid: [-120, 56],
  gatingState: 'staged',
});
/** Shares Copper Ridge's centroid exactly: the case clustering cannot separate. */
const TWIN = project({ id: 3, name: 'Copper Ridge North', sector: 'Mines', centroid: [-124, 50] });

function answer(projects: Project[]) {
  useProjectsMock.mockReturnValue({
    data: { projects, matchCount: projects.length },
    isPending: false,
    isError: false,
  });
}

/** Let whatever a click started finish, for the handlers that await the map. */
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

/** Mount and let the map's load effect settle. */
async function mount() {
  const view = renderScreen(<MapExplorer />);
  await settle();
  return view;
}

/** Rail rows only — the sort `<select>` is a listbox of options too. */
const rail = () => screen.getByRole('listbox', { name: 'Projects' });
const rows = () => within(rail()).queryAllByRole('option').map((row) => row.textContent);
const railRow = (name: RegExp) => within(rail()).getByRole('option', { name });
const card = (name: string) => screen.getByRole('region', { name });
/** A deselected card stays mounted for its exit, so its absence is waited for. */
const cardGone = (name: string) =>
  waitFor(() => expect(screen.queryByRole('region', { name })).toBeNull());

const pin = (id: string) => document.querySelector(`[data-project-id="${id}"]`)!;
/** The stacking order the map gives a pin, read off the marker the stub renders around it. */
const zOf = (id: string) => pin(id).closest('[data-testid="marker"]')?.getAttribute('data-z');
/** Lets the faked clock run, for the specs whose point is a delay. */
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** One project under a cluster, shaped as the source answers `getClusterLeaves`. */
const leaf = (coordinates: [number, number]) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates },
  properties: {},
});

/** The single bubble a spec puts on the map in place of the pins. */
const clusterFeature = {
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [-124, 50] },
  properties: { cluster: true, cluster_id: 7, point_count: 2 },
};

function documents(rows: Partial<Document>[]) {
  useDocumentsMock.mockReturnValue({ data: rows as Document[] });
}

beforeEach(() => {
  // jsdom implements no scrolling, and selecting a project scrolls its rail row into view.
  Element.prototype.scrollIntoView = vi.fn();
  fakeMap.reset();
  answer([MINE, ENERGY]);
  documents([]);
});

afterEach(() => vi.clearAllMocks());

describe('MapExplorer filters', () => {
  it('narrows the rail to one gating state and says so on the chip', async () => {
    const user = userEvent.setup();
    await mount();
    expect(rows()).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    await user.click(screen.getByRole('button', { name: /Gating state/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Staged' }));

    expect(rows()).toEqual([expect.stringContaining('Alder Wind')]);
    expect(screen.getByRole('button', { name: 'Remove filter' })).toHaveTextContent('Staged');
  });

  it('counts each sector under the other active filters, not under itself', async () => {
    const user = userEvent.setup();
    answer([MINE, TWIN, ENERGY]);
    await mount();

    await user.click(screen.getByRole('button', { name: /^Filters/ }));

    // Two mines, one energy — and picking Mines must not restate either count.
    expect(screen.getByRole('checkbox', { name: 'Mines (2)' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Energy (1)' })).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Mines (2)' }));
    expect(screen.getByRole('checkbox', { name: 'Mines (2)' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Energy (1)' })).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
  });

  it('keeps a picked sector on screen at zero once another filter empties it', async () => {
    const user = userEvent.setup();
    answer([MINE, ENERGY]);
    await mount();

    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Mines (1)' }));

    // Peace holds only the energy project, so the picked Mines chip now matches nothing.
    await user.click(screen.getByRole('button', { name: /Environmental region/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Peace' }));

    expect(screen.getByRole('checkbox', { name: 'Mines (0)' })).toBeChecked();
    expect(rows()).toHaveLength(0);
  });

  it('puts every row back when the chips are cleared', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    await user.click(screen.getByRole('button', { name: /Gating state/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Staged' }));
    expect(rows()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Close filters' }));
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(rows()).toHaveLength(2);
  });
});

describe('MapExplorer selection', () => {
  it('marks the selected row for assistive tech and names it on the card', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(railRow(/Copper Ridge/));

    expect(railRow(/Copper Ridge/)).toHaveAttribute('aria-selected', 'true');
    expect(railRow(/Alder Wind/)).toHaveAttribute('aria-selected', 'false');
    expect(card('Copper Ridge')).toBeInTheDocument();
  });

  it('deselects when the selected row is clicked again', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(railRow(/Copper Ridge/));
    expect(railRow(/Copper Ridge/)).toHaveAttribute('aria-selected', 'true');

    await user.click(railRow(/Copper Ridge/));
    expect(railRow(/Copper Ridge/)).toHaveAttribute('aria-selected', 'false');
    await cardGone('Copper Ridge');
  });

  it('clears from the card ✕ and puts focus back on the rail row', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(railRow(/Copper Ridge/));
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));

    await cardGone('Copper Ridge');
    expect(document.activeElement).toBe(railRow(/Copper Ridge/));
  });

  it('lists projects sharing the centroid, so a stacked one can still be picked', async () => {
    const user = userEvent.setup();
    answer([MINE, TWIN, ENERGY]);
    await mount();

    // By id, not by name: "Copper Ridge" is a prefix of its neighbour's name.
    await user.click(document.getElementById(`demi-row-${MINE.id}`)!);

    const twin = within(card('Copper Ridge')).getByRole('button', {
      name: 'Copper Ridge North',
    });
    await user.click(twin);

    // Alder Wind sits elsewhere, so it is never offered as a neighbour.
    const moved = card('Copper Ridge North');
    expect(within(moved).getByRole('button', { name: 'Copper Ridge' })).toBeInTheDocument();
    expect(within(moved).queryByRole('button', { name: 'Alder Wind' })).toBeNull();
  });
});

describe('MapExplorer narrow screen', () => {
  const listButton = () => screen.getByRole('button', { name: /^List/ });
  const mapButton = () => screen.getByRole('button', { name: 'Map' });
  const mapRegion = () => screen.getByRole('region', { name: /^Map of B\.C\./ });

  it('opens on the map, with the list out of reach until it is switched to', async () => {
    const user = userEvent.setup();
    stubNarrow(true);
    await mount();

    expect(mapButton()).toHaveAttribute('aria-pressed', 'true');
    expect(listButton()).toHaveAttribute('aria-pressed', 'false');
    expect(listButton()).toHaveAccessibleName('List 2 projects');
    expect(rail().closest('[inert]')).not.toBeNull();
    expect(mapRegion().closest('[inert]')).toBeNull();

    await user.click(listButton());

    expect(listButton()).toHaveAttribute('aria-pressed', 'true');
    expect(mapButton()).toHaveAttribute('aria-pressed', 'false');
    expect(rail().closest('[inert]')).toBeNull();
    expect(mapRegion().closest('[inert]')).not.toBeNull();
    expect(document.activeElement).toBe(listButton());
  });

  it('takes a picked row to the map and puts focus on its card', async () => {
    const user = userEvent.setup();
    stubNarrow(true);
    await mount();

    await user.click(listButton());
    await user.click(railRow(/Copper Ridge/));

    expect(mapButton()).toHaveAttribute('aria-pressed', 'true');
    expect(mapRegion().closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(
      within(card('Copper Ridge')).getByRole('heading', { name: 'Copper Ridge' }),
    );
  });

  it('hands focus to the List switch when the card closes, since the row is hidden', async () => {
    const user = userEvent.setup();
    stubNarrow(true);
    await mount();

    await user.click(listButton());
    await user.click(railRow(/Copper Ridge/));
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));

    await cardGone('Copper Ridge');
    expect(document.activeElement).toBe(listButton());
    expect(mapButton()).toHaveAttribute('aria-pressed', 'true');
  });

  it('stays on the list when the selected row is picked again, which deselects it', async () => {
    const user = userEvent.setup();
    stubNarrow(true);
    await mount();

    await user.click(listButton());
    await user.click(railRow(/Copper Ridge/));
    await user.click(listButton());
    await user.click(railRow(/Copper Ridge/));

    expect(listButton()).toHaveAttribute('aria-pressed', 'true');
    expect(railRow(/Copper Ridge/)).toHaveAttribute('aria-selected', 'false');
    expect(document.activeElement).toBe(railRow(/Copper Ridge/));
  });

  it('gives a later pin pick no focus when the row picked first never resolved', async () => {
    const user = userEvent.setup();
    stubNarrow(true);
    await mount();

    await user.click(listButton());
    // The list re-reads as the pick lands, and the picked project is gone from the answer.
    answer([ENERGY]);
    await user.click(railRow(/Copper Ridge/));
    await user.click(pin('2'));

    expect(card('Alder Wind')).toBeInTheDocument();
    expect(document.activeElement).not.toBe(
      within(card('Alder Wind')).getByRole('heading', { name: 'Alder Wind' }),
    );
  });

  /** A viewport that crosses the breakpoint mid-spec, telling `useNarrow` as a browser would. */
  function resizableViewport() {
    let matches = false;
    const listeners = new Set<() => void>();
    window.matchMedia = (media: string) =>
      ({
        get matches() {
          return matches;
        },
        media,
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      }) as unknown as MediaQueryList;
    return (narrow: boolean) =>
      act(() => {
        matches = narrow;
        listeners.forEach((listener) => listener());
      });
  }

  it('narrows onto the list when focus is in the rail, so focus is not stranded', async () => {
    const resize = resizableViewport();
    await mount();
    const search = screen.getByRole('textbox', { name: 'Search projects' });
    search.focus();

    resize(true);

    expect(listButton()).toHaveAttribute('aria-pressed', 'true');
    expect(rail().closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it('narrows onto the map when focus is elsewhere', async () => {
    const resize = resizableViewport();
    await mount();
    screen.getByRole('textbox', { name: 'Search projects' }).focus();
    resize(true);
    resize(false);
    screen.getByRole('button', { name: /^Layers/ }).focus();

    resize(true);

    expect(mapButton()).toHaveAttribute('aria-pressed', 'true');
    expect(rail().closest('[inert]')).not.toBeNull();
  });

  it('shows both panes and no switch on a wide screen', async () => {
    await mount();

    expect(screen.queryByRole('group', { name: 'Show projects as' })).toBeNull();
    expect(document.querySelector('[inert]')).toBeNull();
  });
});

describe('MapExplorer camera', () => {
  // Angular opened at Leaflet zoom 5, which is 4 here: MapLibre counts 512 px tiles, Leaflet 256.
  it('opens on the province at the Leaflet opening view', async () => {
    await mount();

    expect(stub.mapProps?.initialViewState).toEqual({
      longitude: -125,
      latitude: 54,
      zoom: 4,
    });
  });

  it('flies in only from a province-wide view, and only to zoom 7', async () => {
    const user = userEvent.setup();
    fakeMap.setMapZoom(5);
    await mount();

    await user.click(railRow(/Copper Ridge/));

    expect(fakeMap.flyTo).toHaveBeenCalledWith(
      expect.objectContaining({ center: [-124, 50], zoom: 7 }),
    );
    expect(fakeMap.easeTo).not.toHaveBeenCalled();
  });

  it('eases, never zooms, to a marker picked from a closer view', async () => {
    const user = userEvent.setup();
    fakeMap.setMapZoom(9);
    await mount();

    await user.click(railRow(/Copper Ridge/));

    expect(fakeMap.easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-124, 50] }));
    expect(fakeMap.easeTo.mock.calls[0]?.[0]).not.toHaveProperty('zoom');
    expect(fakeMap.flyTo).not.toHaveBeenCalled();
  });

  it('eases to a pin picked on the map, the way a rail row does', async () => {
    const user = userEvent.setup();
    fakeMap.setMapZoom(9);
    await mount();

    await user.click(pin('1'));

    expect(fakeMap.easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-124, 50] }));
  });

  it('flies to a pin picked from a province-wide view', async () => {
    const user = userEvent.setup();
    fakeMap.setMapZoom(5);
    await mount();

    await user.click(pin('1'));

    expect(fakeMap.flyTo).toHaveBeenCalledWith(
      expect.objectContaining({ center: [-124, 50], zoom: 7 }),
    );
  });

  it('fits a cluster to the projects under it, rather than stepping one zoom', async () => {
    const user = userEvent.setup();
    // Before the mount: the map reads its features once the style has loaded.
    fakeMap.setFeatures([clusterFeature]);
    fakeMap.setClusterLeaves([leaf([-124, 50]), leaf([-120, 56])]);
    await mount();

    await user.click(screen.getByTestId('map-cluster'));
    await settle();

    expect(fakeMap.fitBounds).toHaveBeenCalledWith(
      [
        [-124, 50],
        [-120, 56],
      ],
      expect.objectContaining({ padding: 80, maxZoom: 11, essential: true }),
    );
    expect(fakeMap.easeTo).not.toHaveBeenCalled();
  });

  it('steps one zoom into a cluster whose projects share a coordinate', async () => {
    const user = userEvent.setup();
    fakeMap.setFeatures([clusterFeature]);
    fakeMap.setClusterLeaves([leaf([-124, 50]), leaf([-124, 50])]);
    await mount();

    await user.click(screen.getByTestId('map-cluster'));
    await settle();

    expect(fakeMap.easeTo).toHaveBeenCalledWith(
      expect.objectContaining({ center: [-124, 50], zoom: 11, essential: true }),
    );
    expect(fakeMap.fitBounds).not.toHaveBeenCalled();
  });

  // `stubNarrow(true)` answers every media query with a match, reduced motion among them. maplibre
  // jumps instead of animating under that preference unless the call is marked essential.
  it.each([true, false])(
    'flies at full duration whatever the media queries report (matches: %s)',
    async (matches) => {
      const user = userEvent.setup();
      stubNarrow(matches);
      fakeMap.setMapZoom(5);
      await mount();

      await user.click(railRow(/Copper Ridge/));

      expect(fakeMap.flyTo).toHaveBeenCalledWith(
        expect.objectContaining({ center: [-124, 50], essential: true }),
      );
      expect(fakeMap.flyTo.mock.calls[0]?.[0]).not.toMatchObject({ duration: 0 });

      // The nearer view eases rather than flies, and that move plays too.
      fakeMap.setMapZoom(9);
      await user.click(railRow(/Alder Wind/));

      expect(fakeMap.easeTo).toHaveBeenCalledWith(
        expect.objectContaining({ center: [-120, 56], essential: true }),
      );
      expect(fakeMap.easeTo.mock.calls[0]?.[0]).not.toMatchObject({ duration: 0 });
    },
  );

  it('eases at the pan duration, and says the move is essential', async () => {
    const user = userEvent.setup();
    fakeMap.setMapZoom(9);
    await mount();

    await user.click(railRow(/Copper Ridge/));

    expect(fakeMap.easeTo).toHaveBeenCalledWith(
      expect.objectContaining({ duration: CAMERA_PAN.duration, essential: true }),
    );
  });

  // maplibre turns a flight it thinks would run past `maxDuration` into an instant jump, so the
  // flight carries a duration and nothing that can cancel it.
  it('flies at the flight duration, with no maxDuration to cut it short', async () => {
    const user = userEvent.setup();
    fakeMap.setMapZoom(5);
    await mount();

    await user.click(railRow(/Copper Ridge/));

    const options = fakeMap.flyTo.mock.calls[0]?.[0];
    expect(options).toMatchObject({ duration: CAMERA_FLY.duration, essential: true });
    expect(options).not.toHaveProperty('maxDuration');
    expect(options).not.toHaveProperty('speed');
  });

  it('fits a cluster at the fit duration', async () => {
    const user = userEvent.setup();
    fakeMap.setFeatures([clusterFeature]);
    fakeMap.setClusterLeaves([leaf([-124, 50]), leaf([-120, 56])]);
    await mount();

    await user.click(screen.getByTestId('map-cluster'));
    await settle();

    expect(fakeMap.fitBounds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ duration: CAMERA_FIT.duration }),
    );
  });
});

describe('MapExplorer escape', () => {
  it('clears the selection on Escape', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(railRow(/Copper Ridge/));
    expect(card('Copper Ridge')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await cardGone('Copper Ridge');
  });

  it('leaves an applied filter alone when Escape clears a selection', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    await user.click(screen.getByRole('button', { name: /Gating state/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Staged' }));
    await user.click(screen.getByRole('button', { name: 'Close filters' }));
    await user.click(railRow(/Alder Wind/));

    await user.keyboard('{Escape}');

    await cardGone('Alder Wind');
    expect(screen.getByRole('button', { name: 'Remove filter' })).toHaveTextContent('Staged');
  });
});

describe('MapExplorer search', () => {
  // Fake timers only here: userEvent and a faked clock deadlock, and these are the behaviours
  // whose point is the delay.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function type(value: string, ms = 300) {
    renderScreen(<MapExplorer />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('asks the API for the typed words, once the typing has stopped', async () => {
    await type('copper', 299);
    expect(useProjectsMock).not.toHaveBeenCalledWith('copper');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(useProjectsMock).toHaveBeenCalledWith('copper');
  });

  it('re-filters the server answer, so a stemmed or scored extra row does not show', async () => {
    // The mock answers every query with both rows, as a scoring index can.
    await type('coppar');
    expect(rows()).toEqual([expect.stringContaining('Copper Ridge')]);
  });

  it('marks the typed words in the row title', async () => {
    await type('copper');
    const marked = within(railRow(/Copper Ridge/)).getByText('Copper', { selector: 'mark' });
    expect(marked).toBeInTheDocument();
  });

  it('prefers the markup the index returned over what a regex can find', async () => {
    answer([
      project({ id: 9, name: 'Peace flooding', highlighted: { name: 'Peace <mark>flooding</mark>' } }),
    ]);
    await type('flood');
    expect(within(railRow(/Peace/)).getByText('flooding', { selector: 'mark' })).toBeInTheDocument();
  });

  it('quotes what is in the box, not the words the API was last asked for', async () => {
    await type('quarrying somewhere else');
    expect(screen.getByText(/No projects match/)).toHaveTextContent('quarrying somewhere else');

    // A further keystroke, before the debounce has carried it anywhere.
    fireEvent.change(screen.getByLabelText('Search projects'), {
      target: { value: 'quarrying somewhere else entirely' },
    });
    expect(screen.getByText(/No projects match/)).toHaveTextContent(
      'quarrying somewhere else entirely',
    );
  });
});

describe('MapExplorer selected card', () => {
  async function open(name: RegExp) {
    const user = userEvent.setup();
    await mount();
    await user.click(railRow(name));
    return user;
  }

  it('shows the summary facts while the card is closed, and swaps them for the field list', async () => {
    const user = await open(/Copper Ridge/);
    const panel = card('Copper Ridge');
    expect(within(panel).getByText('Sector')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: /All fields/ }));

    expect(within(panel).queryByText('Sector')).toBeNull();
    expect(within(panel).getByText(/Track is the master registry/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Less/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('points the field list chevron up while shut and down once open, the way the card grows', async () => {
    const user = await open(/Copper Ridge/);
    const panel = card('Copper Ridge');
    // The drawn chevron points down; a half turn points it up.
    const chevron = () => within(panel).getByTestId('card-fields-chevron');
    expect(chevron().style.transform).toBe('rotate(180deg)');

    await user.click(within(panel).getByRole('button', { name: /All fields/ }));

    expect(chevron().style.transform).toBe('none');
  });

  it('keeps the fields on screen, out of reach, while the card shrinks after "Less"', async () => {
    const user = await open(/Copper Ridge/);
    const panel = card('Copper Ridge');
    await user.click(within(panel).getByRole('button', { name: /All fields/ }));

    await user.click(within(panel).getByRole('button', { name: /Less/ }));

    expect(panel).toHaveAttribute('data-expanded', 'closing');
    expect(within(panel).getByText(/Track is the master registry/).closest('[inert]')).not.toBeNull();
    expect(within(panel).getByRole('button', { name: /All fields/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    fireEvent.transitionEnd(panel, { propertyName: 'max-height' });

    expect(panel).toHaveAttribute('data-expanded', 'false');
    expect(within(panel).queryByText(/Track is the master registry/)).toBeNull();
    expect(within(panel).getByText('Sector')).toBeInTheDocument();
  });

  it('stays open when "All fields" is pressed again before the close has run', async () => {
    const user = await open(/Copper Ridge/);
    const panel = card('Copper Ridge');
    await user.click(within(panel).getByRole('button', { name: /All fields/ }));
    await user.click(within(panel).getByRole('button', { name: /Less/ }));

    await user.click(within(panel).getByRole('button', { name: /All fields/ }));
    const fields = () => within(panel).getByText(/Track is the master registry/);
    expect(fields().closest('[inert]')).toBeNull();

    // The end of the grow the reopen started.
    fireEvent.transitionEnd(panel, { propertyName: 'max-height' });

    expect(panel).toHaveAttribute('data-expanded', 'true');
    expect(fields().closest('[inert]')).toBeNull();
  });

  it('lists the field rows tagged with their source, and narrows to one source on a tab', async () => {
    answer([
      project({
        id: 1,
        name: 'Copper Ridge',
        legacyEagleId: 'eagle-1',
        rawMetadata: {
          trackAttributes: { lead_agency: 'EAO' },
          eagleAttributes: { responsibleEPD: 'A. Director' },
        },
      }),
    ]);
    const user = await open(/Copper Ridge/);
    const panel = card('Copper Ridge');
    await user.click(within(panel).getByRole('button', { name: /All fields/ }));

    expect(within(panel).getByText('Lead agency')).toBeInTheDocument();
    expect(within(panel).getByText('Responsible epd')).toBeInTheDocument();
    expect(within(panel).getByText('DEMI id')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Track' }));

    expect(within(panel).getByRole('button', { name: 'Track' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(panel).getByText('Lead agency')).toBeInTheDocument();
    expect(within(panel).queryByText('Responsible epd')).toBeNull();
    expect(within(panel).queryByText('DEMI id')).toBeNull();
  });

  it('counts only the documents belonging to the selected project', async () => {
    documents([{ projectId: 1 }, { projectId: 1 }, { projectId: 2 }]);
    await open(/Copper Ridge/);

    expect(
      within(card('Copper Ridge')).getByRole('button', { name: 'Documents (2)' }),
    ).toBeInTheDocument();
  });

  it('sends the project name to Search as its keywords', async () => {
    const user = await open(/Copper Ridge/);
    await user.click(within(card('Copper Ridge')).getByRole('button', { name: /^Documents/ }));

    expect(navigateMock).toHaveBeenCalledWith('/search?keywords=Copper%20Ridge');
  });

  /** After the render: `userEvent.setup()` installs a clipboard stub of its own. */
  function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  }

  it('copies the project id and says so on the button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = await open(/Copper Ridge/);
    stubClipboard(writeText);

    await user.click(screen.getByRole('button', { name: 'Copy id' }));

    expect(writeText).toHaveBeenCalledWith('1');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('leaves the button alone when the clipboard refuses', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const user = await open(/Copper Ridge/);
    stubClipboard(writeText);

    await user.click(screen.getByRole('button', { name: 'Copy id' }));

    expect(screen.getByRole('button', { name: 'Copy id' })).toBeInTheDocument();
  });
});

describe('MapExplorer selection dimming', () => {
  const host = () => document.getElementById('demi-map')!;

  it('dims the rest of the map only while the selection has a pin of its own', async () => {
    const user = userEvent.setup();
    await mount();
    expect(host().className).not.toContain('demi-map--selection');

    await user.click(railRow(/Copper Ridge/));
    expect(host().className).toContain('demi-map--selection');
    expect(document.querySelector('.demi-marker--selected')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(host().className).not.toContain('demi-map--selection');
  });

  // The pins keep their source order, so the selected one rises on z-index alone: moving its node
  // would re-insert it, and a re-inserted node replays the pin's enter animation.
  it('raises the selected pin over the one sharing its coordinates on z-index', async () => {
    const user = userEvent.setup();
    answer([MINE, TWIN]);
    await mount();

    // The first of the pair, so the source order alone would leave it underneath.
    await user.click(railRow(/^Copper Ridgeadmitted/));

    expect(zOf('1')).toBe('650');
    expect(zOf('3')).toBe('600');
  });

  it('dims nothing while the selected project is still inside a cluster', async () => {
    const user = userEvent.setup();
    await mount();
    // One bubble covering both projects: the selection has no marker element to accent.
    act(() =>
      fakeMap.setFeatures([
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-124, 50] },
          properties: { cluster: true, cluster_id: 7, point_count: 2 },
        },
      ]),
    );

    await user.click(railRow(/Copper Ridge/));

    expect(host().className).not.toContain('demi-map--selection');
  });
});

describe('MapExplorer markers', () => {
  const pins = () => document.querySelectorAll('[data-testid="map-marker"]');

  // Pins are keyed by project, so picking a different one must not rebuild the rest: a rebuilt node
  // replays the pin's enter animation.
  it('keeps an untouched pin on the same DOM node across a selection change', async () => {
    const user = userEvent.setup();
    await mount();
    const before = pin('2');

    await user.click(railRow(/Copper Ridge/));

    expect(pin('2')).toBe(before);
  });

  it('re-reads the pins on a painted frame, rather than waiting for the move to end', async () => {
    await mount();
    expect(pins()).toHaveLength(2);

    // Part-way through a camera move the worker has merged both pins into one bubble. The stub's
    // `setFeatures` fires the map's render handler and nothing else.
    act(() => fakeMap.setFeatures([clusterFeature]));

    expect(pins()).toHaveLength(0);
    expect(screen.getByTestId('map-cluster')).toHaveTextContent('2');
  });

  // The pin is hidden from assistive tech, which reads the rail row instead; only sighted hover
  // needs the name on the map.
  it('names the project on its pin with the hover label', async () => {
    await mount();

    expect(pin('1').querySelector('.demi-marker__label')).toHaveTextContent('Copper Ridge');
  });

  it('gives a hidden pin no accessible name', async () => {
    await mount();

    expect(pin('1')).toHaveAttribute('aria-hidden', 'true');
    expect(pin('1')).not.toHaveAttribute('aria-label');
  });

  it('stacks a cluster bubble in the pin band', async () => {
    fakeMap.setFeatures([clusterFeature]);
    await mount();

    expect(screen.getByTestId('map-cluster').closest('[data-testid="marker"]')).toHaveAttribute(
      'data-z',
      '600',
    );
  });

  it('leaves a cluster bubble unnamed, since it stands for no one project', async () => {
    fakeMap.setFeatures([clusterFeature]);
    await mount();

    const cluster = screen.getByTestId('map-cluster');
    expect(cluster.querySelector('.demi-marker__label')).toBeNull();
    expect(cluster).not.toHaveAttribute('aria-label');
  });
});

describe('MapExplorer marker read-back', () => {
  /** A single-project point, shaped as the clustered source answers it. */
  const point = (id: string, coordinates: [number, number]) => ({
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates },
    properties: { id },
  });

  /** Mounts inside a profiler, so a spec can tell whether a painted frame re-rendered the screen. */
  async function mountProfiled() {
    const commits = vi.fn();
    renderScreen(
      <Profiler id="map" onRender={commits}>
        <MapExplorer />
      </Profiler>,
    );
    await settle();
    commits.mockClear();
    return commits;
  }

  it('leaves the markers alone on a painted frame that changed nothing', async () => {
    const commits = await mountProfiled();

    act(() => fakeMap.repaint());

    expect(commits).not.toHaveBeenCalled();
  });

  it('leaves the markers alone when the same pins come back in another order', async () => {
    fakeMap.setFeatures([point('1', [-124, 50]), point('2', [-120, 56])]);
    const commits = await mountProfiled();

    act(() => fakeMap.setFeatures([point('2', [-120, 56]), point('1', [-124, 50])]));

    expect(commits).not.toHaveBeenCalled();
  });
});

describe('MapExplorer copy id', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts no reset timer when the copy lands after the screen has gone', async () => {
    const copy = { resolve: (): void => undefined };
    const writeText = vi.fn(() => new Promise<void>((resolve) => (copy.resolve = resolve)));
    const view = renderScreen(<MapExplorer />);
    await tick(0);
    fireEvent.click(railRow(/Copper Ridge/));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copy id' }));
    view.unmount();
    // Only the "Copied" reset runs 2s; the query cache's own clean-up timers are not the screen's.
    const timers = vi.spyOn(globalThis, 'setTimeout');

    await act(async () => copy.resolve());

    expect(timers).not.toHaveBeenCalledWith(expect.any(Function), 2000);
  });
});

describe('MapExplorer card field close backstop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('swaps the fields back for the facts even when no transition end arrives', async () => {
    renderScreen(<MapExplorer />);
    await tick(0);
    fireEvent.click(railRow(/Copper Ridge/));
    const panel = card('Copper Ridge');
    fireEvent.click(within(panel).getByRole('button', { name: /All fields/ }));
    fireEvent.click(within(panel).getByRole('button', { name: /Less/ }));
    expect(panel).toHaveAttribute('data-expanded', 'closing');

    await tick(220);

    expect(panel).toHaveAttribute('data-expanded', 'false');
    expect(within(panel).getByText('Sector')).toBeInTheDocument();
  });
});

describe('MapExplorer arrival pulse', () => {
  // Fake timers only here: userEvent and a faked clock deadlock, so clicks go through fireEvent.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rings the selected pin, and stops once the animation has had its 700ms', async () => {
    renderScreen(<MapExplorer />);
    await tick(0);

    fireEvent.click(railRow(/Copper Ridge/));
    await tick(699);
    expect(pin('1').className).toContain('demi-marker--arriving');

    await tick(1);
    expect(pin('1').className).not.toContain('demi-marker--arriving');
    // The selection itself outlives the pulse.
    expect(pin('1').className).toContain('demi-marker--selected');
  });
});

describe('MapExplorer card motion', () => {
  // Fake timers only here: userEvent and a faked clock deadlock, so clicks go through fireEvent.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const cardNode = () => document.querySelector('.demi-map-card');
  const clear = () => fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));

  it('holds the card through its exit, then takes it off', async () => {
    renderScreen(<MapExplorer />);
    await tick(0);

    fireEvent.click(railRow(/Copper Ridge/));
    clear();

    await tick(139);
    expect(cardNode()?.className).toContain('demi-map-card--closing');
    expect(card('Copper Ridge')).toBeInTheDocument();

    await tick(1);
    expect(cardNode()).toBeNull();
  });

  // `stubNarrow(true)` answers every media query with a match, reduced motion among them.
  it('holds the card through its exit whatever the media queries report', async () => {
    stubNarrow(true);
    renderScreen(<MapExplorer />);
    await tick(0);

    fireEvent.click(railRow(/Copper Ridge/));
    clear();

    await tick(139);
    expect(cardNode()?.className).toContain('demi-map-card--closing');

    await tick(1);
    expect(cardNode()).toBeNull();
  });

  it('swaps the card over to another project without playing the exit', async () => {
    answer([MINE, TWIN, ENERGY]);
    renderScreen(<MapExplorer />);
    await tick(0);

    // By id, not by name: "Copper Ridge" is a prefix of its neighbour's name.
    fireEvent.click(document.getElementById(`demi-row-${MINE.id}`)!);
    fireEvent.click(
      within(card('Copper Ridge')).getByRole('button', { name: 'Copper Ridge North' }),
    );

    expect(cardNode()?.className).not.toContain('demi-map-card--closing');
    expect(card('Copper Ridge North')).toBeInTheDocument();
  });
});
