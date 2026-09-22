import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Workspace } from './Workspace';
import { renderScreen } from '../test-query';
import { json, requests } from '../test-http';
import { type Session } from '../session/session';
import { ANONYMOUS_SESSION } from '../session/session';
import { DEFAULT_PREFS, PREFS_KEY } from '../shell/prefs';
import { takePendingLasso } from '../map/pending-lasso';

vi.mock('../config', () => ({ config: () => ({ API_PATH: '/api', KEYCLOAK_ENABLED: false }) }));

const CLAIMS = {
  sessionId: 's1',
  preferredUsername: 'jsmith',
  name: 'Jane Smith',
  email: 'jane.smith@gov.bc.ca',
  idirUsername: 'JSMITH',
  groups: ['EAO'],
};

const claims = vi.fn<() => typeof CLAIMS | null>(() => CLAIMS);

vi.mock('../api/keycloak', () => ({
  getToken: () => 'staff-token',
  refreshToken: async () => true,
  getSessionClaims: () => claims(),
}));

// The real one needs WebGL. What matters here is that it is lazy, which ring it is handed, and
// that swapping areas does not build a second map.
const built = vi.hoisted(() => vi.fn());
vi.mock('../map/MiniMap', async () => {
  const { useEffect } = await import('react');
  const FakeMiniMap = ({ ring }: { ring: number[][] }) => {
    useEffect(built, []);
    return <div data-testid="mini-map" data-ring={JSON.stringify(ring)} />;
  };
  return { default: FakeMiniMap };
});

const navigate = vi.fn();
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigate,
}));

const LASSOS = [
  { slug: 'skeena', name: 'Skeena', ring: [[-127, 54], [-126, 54], [-126, 55]], updatedAt: '2026-09-03T00:00:00Z' },
  { slug: 'peace', name: 'Peace', ring: [[-120, 56], [-119, 56], [-119, 57]], updatedAt: '2026-09-04T00:00:00Z' },
];

const QUERIES = [
  { slug: 'mines', name: 'Mines', params: 'record=projects&keywords=mine&type=Mine', savedAt: '2026-09-01T00:00:00Z' },
];

const LINKS = [
  { id: 'a1', url: 'https://projects.eao.gov.bc.ca/p/1', note: 'Mine file', shortUrl: 'https://p.eao/s/mine', createdAt: '', createdBy: 'JSmith', updatedAt: null, personal: true },
  { id: 'b2', url: 'https://projects.eao.gov.bc.ca/p/2', note: null, shortUrl: 'https://p.eao/s/other', createdAt: '', createdBy: 'someoneelse', updatedAt: null, personal: false },
];

const MY_DATA = { prefs: { landing: 'search', perPage: 24 }, lassos: LASSOS, queries: QUERIES };

const SIGNED_IN: Session = {
  ...ANONYMOUS_SESSION,
  settled: true,
  authenticated: true,
  userName: 'Jane Smith',
  roles: ['sysadmin', 'staff'],
  isStaff: true,
};

/** Answers by path, because the screen's two reads race and an ordered stub would swap them. */
function serve(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (...args: unknown[]) => {
    const path = new URL(String(args[0])).pathname;
    const answer = routes[path];
    if (!answer) throw new Error(`no stub for ${path}`);
    return answer();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const loaded = () =>
  serve({
    '/api/me/data': () => json(MY_DATA),
    '/api/links': () => json(LINKS),
  });

const renderWorkspace = (session: Session = SIGNED_IN) => renderScreen(<Workspace />, session);

const areaRows = () => screen.getAllByRole('listitem').filter((row) => row.querySelector('[aria-current], .cell__title'));

beforeEach(() => {
  vi.unstubAllGlobals();
  navigate.mockClear();
  built.mockClear();
  claims.mockReturnValue(CLAIMS);
  localStorage.clear();
});

describe('Workspace', () => {
  it('lists every saved area and labels the preview with the first one', async () => {
    loaded();
    renderWorkspace();

    expect(await screen.findByRole('button', { name: /Skeena/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Peace/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Map of Skeena' })).toBeTruthy();
  });

  it('swaps the preview to the area picked from the list', async () => {
    loaded();
    renderWorkspace();

    await userEvent.click(await screen.findByRole('button', { name: /Peace/ }));

    expect(screen.getByRole('img', { name: 'Map of Peace' })).toBeTruthy();
  });

  it('draws the selected area on the preview map and redraws it on a swap', async () => {
    loaded();
    renderWorkspace();

    const drawn = await screen.findByTestId('mini-map');
    expect(JSON.parse(drawn.dataset['ring'] as string)).toEqual(LASSOS[0].ring);

    await userEvent.click(screen.getByRole('button', { name: /Peace/ }));

    expect(JSON.parse(screen.getByTestId('mini-map').dataset['ring'] as string)).toEqual(
      LASSOS[1].ring,
    );
    // The same map, re-framed: rebuilding it would throw away the WebGL context and its worker.
    expect(built).toHaveBeenCalledTimes(1);
  });

  it('leaves the map out of the page when the account has no saved area', async () => {
    serve({
      '/api/me/data': () => json({ ...MY_DATA, lassos: [] }),
      '/api/links': () => json(LINKS),
    });
    renderWorkspace();

    expect(await screen.findByText(/Draw a lasso on/)).toBeTruthy();
    expect(screen.queryByTestId('mini-map')).toBeNull();
  });

  it('marks only the selected row', async () => {
    loaded();
    renderWorkspace();
    await screen.findByRole('button', { name: /Skeena/ });

    const marked = screen.getAllByRole('button').filter((node) => node.getAttribute('aria-current') === 'true');
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain('Skeena');
  });

  it('hands the selection to the next area when the selected one is deleted', async () => {
    let rows = [...LASSOS];
    serve({
      '/api/me/data': () => json({ ...MY_DATA, lassos: rows }),
      '/api/links': () => json(LINKS),
      '/api/me/lassos/skeena': () => {
        rows = rows.filter((area) => area.slug !== 'skeena');
        return json({});
      },
    });
    renderWorkspace();
    await screen.findByRole('button', { name: /Skeena/ });

    const skeena = areaRows().find((row) => row.textContent?.includes('Skeena'))!;
    await userEvent.click(within(skeena).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /Skeena/ })).toBeNull());
    expect(screen.getByRole('img', { name: 'Map of Peace' })).toBeTruthy();
  });

  it('deletes a saved area by its slug', async () => {
    const fetchMock = loaded();
    renderWorkspace();
    await screen.findByRole('button', { name: /Skeena/ });

    const peace = areaRows().find((row) => row.textContent?.includes('Peace'))!;
    await userEvent.click(within(peace).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(requests(fetchMock)).toContain(`DELETE ${window.location.origin}/api/me/lassos/peace`),
    );
  });

  it('puts the ring where the map reads it before navigating there', async () => {
    loaded();
    renderWorkspace();
    await screen.findByRole('button', { name: /Skeena/ });

    const peace = areaRows().find((row) => row.textContent?.includes('Peace'))!;
    await userEvent.click(within(peace).getByRole('button', { name: 'Apply on map' }));

    expect(takePendingLasso()).toEqual({ ring: LASSOS[1].ring, label: 'Peace' });
    expect(navigate).toHaveBeenCalledWith('/map');
  });

  it('lists every saved query with what it narrows to, and counts them', async () => {
    loaded();
    renderWorkspace();

    expect(await screen.findByText('Mines')).toBeTruthy();
    expect(screen.getByText(/Projects · “mine” · 1 filter/)).toBeTruthy();
    expect(screen.getByText('1', { selector: '.pill--info' })).toBeTruthy();
  });

  it('opens a saved query on the search screen with the params it was saved with', async () => {
    loaded();
    renderWorkspace();

    await userEvent.click(await screen.findByRole('button', { name: 'Open Mines in search' }));

    expect(navigate).toHaveBeenCalledWith('/search?record=projects&keywords=mine&type=Mine');
  });

  it('deletes a saved query by its slug', async () => {
    const fetchMock = loaded();
    renderWorkspace();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete Mines' }));

    await waitFor(() =>
      expect(requests(fetchMock)).toContain(`DELETE ${window.location.origin}/api/me/queries/mines`),
    );
  });

  it('points at Search when no query has been saved', async () => {
    serve({ '/api/me/data': () => json({ ...MY_DATA, queries: [] }), '/api/links': () => json(LINKS) });
    renderWorkspace();

    expect(await screen.findByText(/Run a search on/)).toBeTruthy();
  });

  it('invites a first lasso when there are none', async () => {
    serve({ '/api/me/data': () => json({ ...MY_DATA, lassos: [] }), '/api/links': () => json(LINKS) });
    renderWorkspace();

    expect(await screen.findByText(/Draw a lasso on/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: /Map of/ })).toBeNull();
  });

  it('lists my links only, badging the personal one', async () => {
    loaded();
    renderWorkspace();

    expect(await screen.findByText('https://p.eao/s/mine')).toBeTruthy();
    expect(screen.queryByText('https://p.eao/s/other')).toBeNull();
    expect(screen.getByText('Personal')).toBeTruthy();
  });

  it('renders the session roles as chips', async () => {
    loaded();
    renderWorkspace();

    const chips = await screen.findAllByText(/sysadmin|staff/, { selector: '.role-chip' });
    expect(chips.map((chip) => chip.textContent)).toEqual(['sysadmin', 'staff']);
  });

  it('says so when the account carries no role beyond the defaults', async () => {
    loaded();
    renderWorkspace({ ...SIGNED_IN, roles: [] });

    expect(await screen.findByText('None beyond the Keycloak defaults.')).toBeTruthy();
  });

  it('shows the name, IDIR, email and groups the token carries', async () => {
    loaded();
    renderWorkspace();

    expect(await screen.findByText('Jane Smith')).toBeTruthy();
    expect(screen.getByText('JSMITH')).toBeTruthy();
    expect(screen.getByText('jane.smith@gov.bc.ca')).toBeTruthy();
    expect(screen.getByText('EAO')).toBeTruthy();
    expect(screen.getByText('JS')).toBeTruthy();
  });

  it('writes a preference change to BOTH localStorage and the account', async () => {
    const fetchMock = loaded();
    renderWorkspace();
    await screen.findByRole('button', { name: /Skeena/ });

    await userEvent.selectOptions(screen.getByLabelText('Results per page'), '12');

    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ landing: 'search', perPage: 12 });
    await waitFor(() =>
      expect(requests(fetchMock)).toContain(`PUT ${window.location.origin}/api/me/prefs`),
    );
  });

  it('does not call the API for an anonymous visitor, and shows no claim from a past session', async () => {
    claims.mockReturnValue(null);
    const fetchMock = serve({});
    renderWorkspace({ ...ANONYMOUS_SESSION, settled: true });

    await screen.findByText(/Not signed in/);
    await userEvent.selectOptions(screen.getByLabelText('Results per page'), '12');

    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ ...DEFAULT_PREFS, perPage: 12 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(CLAIMS.name)).toBeNull();
    expect(screen.queryByText(CLAIMS.email)).toBeNull();
    expect(screen.queryByText(CLAIMS.idirUsername)).toBeNull();
  });

  it('puts every preference back to its default on reset', async () => {
    loaded();
    renderWorkspace();
    await screen.findByRole('button', { name: /Skeena/ });

    await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual(DEFAULT_PREFS);
    expect((screen.getByLabelText('Default landing screen') as HTMLSelectElement).value).toBe('map');
  });

  it('starts the editor from the account copy once /me/data has answered', async () => {
    loaded();
    renderWorkspace();

    await waitFor(() =>
      expect((screen.getByLabelText('Default landing screen') as HTMLSelectElement).value).toBe('search'),
    );
    expect((screen.getByLabelText('Results per page') as HTMLSelectElement).value).toBe('24');
  });

  it('takes the account copy back once the save has answered, dropping the edit', async () => {
    serve({
      '/api/me/data': () => json(MY_DATA),
      '/api/links': () => json(LINKS),
      // The account answers with what it stored, which is not what was asked for.
      '/api/me/prefs': () => json({ landing: 'search', perPage: 6 }),
    });
    renderWorkspace();
    await screen.findByRole('button', { name: /Skeena/ });

    await userEvent.selectOptions(screen.getByLabelText('Results per page'), '12');

    await waitFor(() =>
      expect((screen.getByLabelText('Results per page') as HTMLSelectElement).value).toBe('6'),
    );
  });

  it('clears the last write failure when the next write starts', async () => {
    serve({
      '/api/me/data': () => json(MY_DATA),
      '/api/links': () => json(LINKS),
      '/api/me/prefs': () => json({ error: 'preferences are read-only' }, 500),
      '/api/me/queries/mines': () => json({}),
    });
    renderWorkspace();
    await screen.findByRole('button', { name: /Skeena/ });

    await userEvent.selectOptions(screen.getByLabelText('Results per page'), '12');
    await screen.findByText('preferences are read-only');

    await userEvent.click(screen.getByRole('button', { name: 'Delete Mines' }));

    await waitFor(() => expect(screen.queryByText('preferences are read-only')).toBeNull());
  });

  it('shows the read failure in its own callout', async () => {
    serve({
      '/api/me/data': () => json({ error: 'userdata unavailable' }, 500),
      '/api/links': () => json(LINKS),
    });
    renderWorkspace();

    expect(await screen.findByText('userdata unavailable')).toBeTruthy();
  });
});
