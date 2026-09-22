import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Project } from '../api/types';
import { CAMERA_FIT } from '../map/map-state';
import { renderScreen } from '../test-query';
import { boundaryCache } from '../api/boundaries';

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

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => vi.fn(),
}));

const { MapExplorer } = await import('./MapExplorer');
const stub = await import('../map/maplibre-test-stub');
const { fakeMap } = stub;

/** A square around (-124, 50), so a fit to it is a recognisable box. */
const SQUARE = {
  type: 'Polygon',
  coordinates: [
    [
      [-125, 49],
      [-123, 49],
      [-123, 51],
      [-125, 51],
      [-125, 49],
    ],
  ],
};

const DISTRICTS = [{ _id: 'b1', name: 'Bulkley-Nechako', type: 'Regional District', geometry: SQUARE }];

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

const INSIDE = project({ id: 1, name: 'Copper Ridge', regionalDistrict: 'Bulkley-Nechako' });
const ELSEWHERE = project({ id: 2, name: 'Alder Wind', regionalDistrict: 'Capital' });

/** A fire whose name carries markup: the popup must show it, never run it. */
const FIRES = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-124.5, 50.5] },
      properties: {
        FIRE_NUMBER: 'C50123',
        INCIDENT_NAME: '<img src=x onerror="alert(1)">',
        FIRE_STATUS: 'Out of Control',
        FIRE_CAUSE: 'Lightning',
        CURRENT_SIZE: 42,
        FIRE_CENTRE: 1,
        FIRE_OF_NOTE_IND: 'Y',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-120, 55] },
      properties: { FIRE_NUMBER: 'V70001', FIRE_STATUS: 'Out' },
    },
  ],
};

const OBSERVATION = {
  features: [
    {
      properties: {
        INVASIVE_PLANT: 'Japanese knotweed (Fallopia japonica)',
        INVASIVE_PLANT_POSITIVE: 'Y',
        ACTIVITY_DATE: '2019-07-04Z',
      },
    },
  ],
};

/** Every request the screen makes, answered from here; nothing leaves the test. */
const calls: string[] = [];
let observationBody: () => Promise<unknown> = () => Promise.resolve(OBSERVATION);

function routeFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const jsonHeaders = () => new Headers({ 'content-type': 'application/json' });
    const json = (data: unknown) =>
      Promise.resolve({
        ok: true,
        headers: jsonHeaders(),
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(''),
      });

    if (url.includes('regional_districts')) return json(DISTRICTS);
    if (url.includes('.geojson') || url.includes('/boundaries')) return json([]);
    if (url.includes('invasive-species.json')) return json({ species: ["Baby's breath"] });
    if (url.includes('GetFeatureInfo')) {
      return Promise.resolve({
        ok: true,
        headers: jsonHeaders(),
        json: observationBody,
        text: () => Promise.resolve(''),
      });
    }
    if (url.includes('resultType=hits')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve('<wfs:FeatureCollection numberMatched="7" />'),
        json: () => Promise.resolve({}),
      });
    }
    if (url.includes('PROT_CURRENT_FIRE_PNTS_SP')) return json(FIRES);
    return json({});
  });
}

async function mount() {
  const view = renderScreen(<MapExplorer />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

const openPanel = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /^Layers/ }));

const railNames = () =>
  screen
    .getAllByRole('option')
    .map((row) => row.textContent || '')
    .filter((text) => text.includes('Project') || text.includes('Ridge') || text.includes('Wind'));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.useRealTimers();
  fakeMap.reset();
  boundaryCache.clear();
  calls.length = 0;
  observationBody = () => Promise.resolve(OBSERVATION);
  vi.stubGlobal('fetch', routeFetch());
  useProjectsMock.mockReturnValue({
    data: { projects: [INSIDE, ELSEWHERE], matchCount: 2 },
    isPending: false,
    isError: false,
  });
  useDocumentsMock.mockReturnValue({ data: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Layers panel', () => {
  it('lists the overlay rows, the two data layers and what the panel is for', async () => {
    const user = userEvent.setup();
    await mount();
    await openPanel(user);

    for (const label of [
      'Environmental regions',
      'Regional districts',
      'Municipalities',
      'Electoral districts',
      'Active wildfires',
      'Invasive species observations',
    ]) {
      expect(screen.getByRole('checkbox', { name: label })).toBeInTheDocument();
    }
    expect(
      screen.getByText('Overlays change the map. Filters change the results.'),
    ).toBeInTheDocument();
    // Environmental regions are on when the screen opens, so the badge starts at one.
    expect(screen.getByRole('button', { name: /^Layers/ })).toHaveTextContent('1');
  });

  it('draws a boundary overlay when its row is ticked, under nothing but the pins', async () => {
    const user = userEvent.setup();
    await mount();
    await openPanel(user);

    await user.click(screen.getByRole('checkbox', { name: 'Regional districts' }));

    await waitFor(() => expect(fakeMap.layerIds()).toContain('regionalDistricts-fill'));
    expect(fakeMap.layerIds()).toContain('regionalDistricts-line');
  });

  it('keeps the boundaries above the invasives raster whichever goes on last', async () => {
    const user = userEvent.setup();
    await mount();
    await openPanel(user);

    await user.click(screen.getByRole('checkbox', { name: 'Regional districts' }));
    await waitFor(() => expect(fakeMap.layerIds()).toContain('regionalDistricts-fill'));
    await user.click(screen.getByRole('checkbox', { name: 'Invasive species observations' }));

    await waitFor(() => expect(fakeMap.layerIds()).toContain('invasives-raster'));
    const order = fakeMap.layerIds();
    expect(order.indexOf('invasives-raster')).toBeLessThan(order.indexOf('regionalDistricts-fill'));
  });

  it('closes on Escape without clearing anything behind it', async () => {
    const user = userEvent.setup();
    await mount();
    await openPanel(user);
    expect(screen.getByRole('checkbox', { name: 'Active wildfires' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('checkbox', { name: 'Active wildfires' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Layers/ })).toHaveFocus();
  });
});

describe('boundary overlays', () => {
  async function showDistricts(user: ReturnType<typeof userEvent.setup>) {
    await openPanel(user);
    await user.click(screen.getByRole('checkbox', { name: 'Regional districts' }));
    await waitFor(() => expect(fakeMap.layerIds()).toContain('regionalDistricts-fill'));
    await user.keyboard('{Escape}');
  }

  const boundaryEvent = () => ({
    features: [{ layer: { id: 'regionalDistricts-fill' }, id: 'Bulkley-Nechako' }],
    point: { x: 10, y: 10 },
    lngLat: { lng: -124, lat: 50 },
  });

  it('marks the hovered shape and unmarks it again', async () => {
    const user = userEvent.setup();
    await mount();
    await showDistricts(user);

    await act(async () => {
      stub.mapProps?.onMouseMove?.(boundaryEvent() as never);
    });
    expect(fakeMap.setFeatureState).toHaveBeenCalledWith(
      { source: 'regionalDistricts', id: 'Bulkley-Nechako' },
      { hover: true },
    );

    await act(async () => {
      stub.mapProps?.onMouseLeave?.({ point: { x: 0, y: 0 } } as never);
    });
    expect(fakeMap.setFeatureState).toHaveBeenCalledWith(
      { source: 'regionalDistricts', id: 'Bulkley-Nechako' },
      { hover: false },
    );
  });

  it('picking a shape filters the rail, marks it selected and brings the camera to it', async () => {
    const user = userEvent.setup();
    await mount();
    await showDistricts(user);
    expect(railNames()).toHaveLength(2);

    await act(async () => {
      stub.mapProps?.onClick?.(boundaryEvent() as never);
    });

    expect(railNames()).toEqual([expect.stringContaining('Copper Ridge')]);
    expect(screen.getByRole('button', { name: 'Remove filter' })).toHaveTextContent(
      'Bulkley-Nechako',
    );
    expect(fakeMap.fitBounds).toHaveBeenCalledWith(
      [
        [-125, 49],
        [-123, 51],
      ],
      expect.objectContaining({
        padding: 30,
        maxZoom: 9,
        duration: CAMERA_FIT.duration,
        essential: true,
      }),
    );
    expect(fakeMap.setFeatureState).toHaveBeenCalledWith(
      { source: 'regionalDistricts', id: 'Bulkley-Nechako' },
      { selected: true },
    );
  });

  it('a boundary click does not also clear the selected project', async () => {
    const user = userEvent.setup();
    await mount();
    await showDistricts(user);
    await user.click(screen.getByRole('option', { name: /Copper Ridge/ }));
    expect(screen.getByRole('region', { name: 'Copper Ridge' })).toBeInTheDocument();

    await act(async () => {
      stub.mapProps?.onClick?.(boundaryEvent() as never);
    });

    expect(screen.getByRole('region', { name: 'Copper Ridge' })).toBeInTheDocument();
  });

  it('ticking a boundary in the drawer turns its overlay on', async () => {
    const user = userEvent.setup();
    await mount();

    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    await user.click(screen.getByRole('button', { name: /Regional district/ }));
    await user.click(await screen.findByRole('checkbox', { name: 'Bulkley-Nechako' }));

    await waitFor(() => expect(fakeMap.layerIds()).toContain('regionalDistricts-fill'));
    expect(railNames()).toEqual([expect.stringContaining('Copper Ridge')]);
  });
});

describe('wildfires', () => {
  it('draws one pill per fire, sized by status, and shows its details as text', async () => {
    const user = userEvent.setup();
    await mount();
    await openPanel(user);

    await user.click(screen.getByRole('checkbox', { name: 'Active wildfires' }));

    const pills = await screen.findAllByTestId('wildfire-marker');
    expect(pills).toHaveLength(2);
    // Fire of note 30px, extinguished 20px.
    expect(pills[0]).toHaveStyle({ width: '30px' });
    expect(pills[1]).toHaveStyle({ width: '20px' });

    await user.click(pills[0]);
    const popup = await screen.findByTestId('wildfire-popup');
    expect(popup).toHaveTextContent('Out of Control');
    expect(popup).toHaveTextContent('42 ha');
    expect(popup).toHaveTextContent('Cariboo Fire Centre');
    // The name arrives as markup and stays a string.
    expect(popup).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(popup.querySelector('img')).toBeNull();
  });
});

describe('invasive species', () => {
  async function showInvasives(user: ReturnType<typeof userEvent.setup>) {
    await openPanel(user);
    await user.click(screen.getByRole('checkbox', { name: 'Invasive species observations' }));
    await waitFor(() => expect(fakeMap.layerIds()).toContain('invasives-raster'));
  }

  it('adds the styled raster and reports the species count once one is typed', async () => {
    const user = userEvent.setup();
    await mount();
    await showInvasives(user);

    const tiles = stub.sourceTilesFor('invasives')?.[0] ?? '';
    expect(tiles).toContain('SLD_BODY');
    expect(tiles).toContain('BBOX={bbox-epsg-3857}');
    expect(screen.getByText('All species')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Species'), "Baby's breath");

    // The typed name reaches the tiles after the pause, with its quote doubled.
    await waitFor(() => {
      const next = (fakeMap.setTiles.mock.calls.at(-1)?.[0] as string[] | undefined)?.[0] ?? '';
      // A query string spends spaces as `+`, which decodeURIComponent leaves alone.
      const cql = decodeURIComponent(next).replace(/\+/g, ' ');
      expect(cql).toContain("INVASIVE_PLANT ILIKE '%Baby''s breath%'");
    });
    expect(await screen.findByText('7 present, 7 absent')).toBeInTheDocument();
  });

  it('asks the WMS about the clicked pixel and shows the observation', async () => {
    const user = userEvent.setup();
    await mount();
    await showInvasives(user);

    await act(async () => {
      stub.mapProps?.onClick?.({
        point: { x: 40, y: 60 },
        lngLat: { lng: -124, lat: 50 },
      } as never);
    });

    const asked = calls.find((url) => url.includes('GetFeatureInfo')) ?? '';
    expect(asked).toContain('I=40');
    expect(asked).toContain('J=60');
    expect(asked).toContain('INFO_FORMAT=application%2Fjson');
    expect(await screen.findByText('Japanese knotweed')).toBeInTheDocument();
    expect(screen.getByTestId('invasives-popup')).toHaveTextContent('Present');
  });

  it('keeps the newest answer when an older one lands last', async () => {
    const user = userEvent.setup();
    await mount();
    await showInvasives(user);

    let releaseFirst: (value: unknown) => void = () => undefined;
    observationBody = () => new Promise((resolve) => (releaseFirst = resolve));
    await act(async () => {
      stub.mapProps?.onClick?.({ point: { x: 1, y: 1 }, lngLat: { lng: -124, lat: 50 } } as never);
    });

    observationBody = () => Promise.resolve(OBSERVATION);
    await act(async () => {
      stub.mapProps?.onClick?.({ point: { x: 2, y: 2 }, lngLat: { lng: -123, lat: 51 } } as never);
    });
    expect(await screen.findByText('Japanese knotweed')).toBeInTheDocument();

    // The first click's answer arrives now, naming a different plant, and is dropped.
    await act(async () => {
      releaseFirst({ features: [{ properties: { INVASIVE_PLANT: 'Spotted knapweed' } }] });
      await Promise.resolve();
    });

    expect(screen.queryByText('Spotted knapweed')).not.toBeInTheDocument();
    expect(screen.getByText('Japanese knotweed')).toBeInTheDocument();
  });

  it('says so when the lookup fails rather than leaving the click silent', async () => {
    const user = userEvent.setup();
    await mount();
    await showInvasives(user);

    observationBody = () => Promise.reject(new Error('XML exception report'));
    await act(async () => {
      stub.mapProps?.onClick?.({ point: { x: 5, y: 5 }, lngLat: { lng: -124, lat: 50 } } as never);
    });

    expect(await screen.findByText('Could not load observation details.')).toBeInTheDocument();
  });

  it('takes the overlay, its popup and its count away again', async () => {
    const user = userEvent.setup();
    await mount();
    await showInvasives(user);
    await act(async () => {
      stub.mapProps?.onClick?.({ point: { x: 5, y: 5 }, lngLat: { lng: -124, lat: 50 } } as never);
    });
    expect(await screen.findByTestId('invasives-popup')).toBeInTheDocument();

    // The panel is still open from `showInvasives`, so the same checkbox switches it back off.
    await user.click(screen.getByRole('checkbox', { name: 'Invasive species observations' }));

    expect(fakeMap.layerIds()).not.toContain('invasives-raster');
    expect(screen.queryByTestId('invasives-popup')).not.toBeInTheDocument();
  });
});
