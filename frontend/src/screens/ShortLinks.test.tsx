import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShortLinks } from './ShortLinks';
import { json, noContent, requests } from '../test-http';
import { renderScreen } from '../test-query';
import type { ShortLink } from '../api/links';

vi.mock('../api/keycloak', () => ({
  getToken: () => 'staff-token',
  refreshToken: async () => false,
  getSessionClaims: () => ({ sessionId: 's1', preferredUsername: 'J.Okafor' }),
}));

const link = (id: string, createdBy: string, personal = false): ShortLink => ({
  id,
  url: `https://demi.gov.bc.ca/projects/${id}`,
  note: null,
  shortUrl: `https://demi.gov.bc.ca/s/${id}`,
  createdAt: '2026-08-24T00:00:00.000Z',
  createdBy,
  updatedAt: null,
  personal,
});

/** Answer the list read with `rows`, and any write with `onWrite`. */
function stub(rows: ShortLink[], onWrite: () => Response = () => noContent()) {
  const fetchMock = vi.fn((_input: unknown, init?: RequestInit) =>
    Promise.resolve(init?.method && init.method !== 'GET' ? onWrite() : json(rows)),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const signedIn = { authenticated: true, isStaff: true };

const rowTexts = () => screen.getAllByRole('row').map((row) => row.textContent ?? '');

beforeEach(() => vi.stubGlobal('confirm', vi.fn(() => true)));

afterEach(() => vi.unstubAllGlobals());

describe('ShortLinks grouping', () => {
  it('puts my links above the shared ones, matching the username case-insensitively', async () => {
    stub([link('shared-a', 'r.singh'), link('mine-a', 'j.okafor')]);

    renderScreen(<ShortLinks />, signedIn);

    await screen.findByText('My links');
    const rows = rowTexts().slice(1);
    expect(rows[0]).toContain('My links');
    expect(rows[1]).toContain('mine-a');
    expect(rows[2]).toContain('Shared links');
    expect(rows[3]).toContain('shared-a');
  });

  it('badges a personal link and leaves a shared one unbadged', async () => {
    stub([link('mine-p', 'j.okafor', true), link('shared-a', 'r.singh')]);

    renderScreen(<ShortLinks />, signedIn);

    await screen.findByText('My links');
    const mine = screen.getAllByRole('row').find((row) => row.textContent?.includes('mine-p'));
    const shared = screen.getAllByRole('row').find((row) => row.textContent?.includes('shared-a'));
    expect(within(mine!).getByText('Personal')).toBeInTheDocument();
    expect(shared!.textContent).not.toContain('Personal');
  });

  it('shows only Shared links when none of them are mine', async () => {
    stub([link('shared-a', 'r.singh')]);

    renderScreen(<ShortLinks />, signedIn);

    expect(await screen.findByText('Shared links')).toBeInTheDocument();
    expect(screen.queryByText('My links')).not.toBeInTheDocument();
  });
});

describe('ShortLinks', () => {
  it('says the list is empty rather than showing a blank table', async () => {
    stub([]);

    renderScreen(<ShortLinks />, signedIn);

    expect(await screen.findByText('No short links yet.')).toBeInTheDocument();
  });

  it('shows the API error message when the list read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Links are unavailable' }, 500)));

    renderScreen(<ShortLinks />, signedIn);

    expect(await screen.findByText('Links are unavailable')).toBeInTheDocument();
  });

  it('creates a link, then re-reads the list', async () => {
    const fetchMock = stub([link('mine-a', 'j.okafor')], () => json({}, 201));
    const user = userEvent.setup();

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('My links');

    await user.click(screen.getByRole('button', { name: 'New short link' }));
    await user.type(screen.getByPlaceholderText('https://projects.eao.gov.bc.ca/…'), 'https://demi.gov.bc.ca/x');
    await user.type(screen.getByPlaceholderText('site-c-eac'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    await waitFor(() => expect(requests(fetchMock).filter((r) => r.startsWith('POST'))).toHaveLength(1));
    const post = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
      url: 'https://demi.gov.bc.ca/x',
      code: 'abc',
      personal: false,
    });
    // The form closes and the list is asked for again, so the new row can appear.
    await waitFor(() => expect(screen.queryByPlaceholderText('site-c-eac')).not.toBeInTheDocument());
    expect(requests(fetchMock).filter((r) => r.startsWith('GET'))).toHaveLength(2);
  });

  it('refuses to create a link with no destination', async () => {
    stub([]);
    const user = userEvent.setup();

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('No short links yet.');
    await user.click(screen.getByRole('button', { name: 'New short link' }));

    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled();
  });

  it('keeps the refusal on screen when the API rejects the code', async () => {
    stub([], () => json({ error: 'Code already in use' }, 409));
    const user = userEvent.setup();

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('No short links yet.');

    await user.click(screen.getByRole('button', { name: 'New short link' }));
    await user.type(screen.getByPlaceholderText('https://projects.eao.gov.bc.ca/…'), 'https://demi.gov.bc.ca/x');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(await screen.findByText('Code already in use')).toBeInTheDocument();
    // The form stays open over the values that were refused.
    expect(screen.getByPlaceholderText('site-c-eac')).toBeInTheDocument();
  });

  it('repoints a row to a new destination', async () => {
    const fetchMock = stub([link('mine-a', 'j.okafor')]);
    const user = userEvent.setup();

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('My links');

    await user.click(screen.getByRole('button', { name: 'Repoint' }));
    const input = screen.getByLabelText('New destination');
    expect(input).toHaveValue('https://demi.gov.bc.ca/projects/mine-a');
    await user.clear(input);
    await user.type(input, 'https://demi.gov.bc.ca/y');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByLabelText('New destination')).not.toBeInTheDocument());
    const put = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PUT');
    expect(String(put![0])).toContain('/api/links/mine-a');
    expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({ url: 'https://demi.gov.bc.ca/y' });
  });

  it('leaves the row in edit mode when the repoint is refused', async () => {
    stub([link('mine-a', 'j.okafor')], () => json({ error: 'Destination must be https' }, 400));
    const user = userEvent.setup();

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('My links');

    await user.click(screen.getByRole('button', { name: 'Repoint' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Destination must be https')).toBeInTheDocument();
    expect(screen.getByLabelText('New destination')).toBeInTheDocument();
  });

  it('cancels a repoint without asking the API', async () => {
    const fetchMock = stub([link('mine-a', 'j.okafor')]);
    const user = userEvent.setup();

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('My links');

    await user.click(screen.getByRole('button', { name: 'Repoint' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('New destination')).not.toBeInTheDocument();
    expect(requests(fetchMock).filter((r) => !r.startsWith('GET'))).toEqual([]);
  });

  it('asks before deleting, naming the short URL that stops working', async () => {
    const fetchMock = stub([link('mine-a', 'j.okafor')]);
    const user = userEvent.setup();

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('My links');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(vi.mocked(confirm).mock.calls[0][0]).toContain('https://demi.gov.bc.ca/s/mine-a');
    await waitFor(() =>
      expect(requests(fetchMock).some((r) => r.startsWith('DELETE'))).toBe(true),
    );
  });

  it('sends nothing when the delete is waved off', async () => {
    const fetchMock = stub([link('mine-a', 'j.okafor')]);
    vi.stubGlobal('confirm', vi.fn(() => false));
    const user = userEvent.setup();

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('My links');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(requests(fetchMock).filter((r) => !r.startsWith('GET'))).toEqual([]);
  });

  it('confirms the copy on the row it was copied from', async () => {
    stub([link('mine-a', 'j.okafor'), link('mine-b', 'j.okafor')]);
    // userEvent.setup() installs its own clipboard, so the spy goes on that, after it.
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('My links');

    await user.click(screen.getAllByRole('button', { name: 'Copy' })[0]);

    expect(writeText).toHaveBeenCalledWith('https://demi.gov.bc.ca/s/mine-a');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    // Only the row that was copied says so.
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(1);
  });

  it('dismisses a failed read when the form is opened, and again when it is closed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Links are unavailable' }, 500)));
    const user = userEvent.setup();

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('Links are unavailable');

    await user.click(screen.getByRole('button', { name: 'New short link' }));
    expect(screen.queryByText('Links are unavailable')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Links are unavailable')).not.toBeInTheDocument();
  });

  it('tells the row when the browser refuses the clipboard', async () => {
    stub([link('mine-a', 'j.okafor')]);
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('write permission denied'));
    // Node reports what nothing caught; `@types/node` is not in this app's tsconfig.
    const node = (globalThis as unknown as {
      process: { on(event: string, fn: () => void): void; off(event: string, fn: () => void): void };
    }).process;
    const unhandled = vi.fn();
    node.on('unhandledRejection', unhandled);

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('My links');

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    // An unhandled rejection is reported a macrotask after the microtask queue drains.
    await new Promise((resolve) => setTimeout(resolve, 0));
    node.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });
});

describe('ShortLinks project codes', () => {
  // The server's wording; the screen keys on the 409 status and projectId, never on this text.
  const HELD = 'This code belongs to a project. Edit it on the project instead.';
  const editOnProject = (code: string) => ({ name: `Edit on the project page for ${code}` });
  const rowOf = (code: string) => screen.getAllByRole('row').find((row) => row.textContent?.includes(code))!;

  it.each([
    ['current', 'Project'],
    ['legacy', 'Old project code'],
  ] as const)('shows a %s project code read-only, linked to the project editor', async (projectRole, pill) => {
    stub([{ ...link('site-c', 'system'), projectId: '272', projectRole }]);

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('Shared links');

    const row = rowOf('site-c');
    expect(within(row).getByRole('link', editOnProject('site-c'))).toHaveAttribute('href', '/projects/272');
    expect(within(row).getByText(pill)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Repoint' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  async function refusedList() {
    stub([link('site-c', 'system')], () => json({ error: HELD, projectId: '272' }, 409));
    const user = userEvent.setup();
    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('Shared links');
    return user;
  }

  it('locks a row whose repoint is refused because a project holds the code', async () => {
    const user = await refusedList();

    await user.click(screen.getByRole('button', { name: 'Repoint' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(HELD)).toBeInTheDocument();
    expect(within(rowOf('site-c')).getByRole('link', editOnProject('site-c'))).toHaveAttribute(
      'href',
      '/projects/272',
    );
    expect(screen.queryByLabelText('New destination')).not.toBeInTheDocument();
  });

  it('locks a row whose delete is refused because a project holds the code', async () => {
    const user = await refusedList();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(HELD)).toBeInTheDocument();
    expect(within(rowOf('site-c')).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(within(rowOf('site-c')).getByText('Project')).toBeInTheDocument();
  });

  it('drops an open repoint when the row turns out to be held by a project', async () => {
    let rows = [link('site-c', 'system'), link('other', 'system')];
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        rows = [{ ...link('site-c', 'system'), projectId: '272', projectRole: 'current' as const }];
        return Promise.resolve(noContent());
      }
      return Promise.resolve(json(rows));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('Shared links');

    await user.click(within(rowOf('site-c')).getByRole('button', { name: 'Repoint' }));
    await user.click(within(rowOf('other')).getByRole('button', { name: 'Delete' }));

    expect(await within(rowOf('site-c')).findByRole('link', editOnProject('site-c'))).toBeInTheDocument();
    expect(screen.queryByLabelText('New destination')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('keeps a row editable after a 409 that names no project', async () => {
    stub([link('mine-a', 'j.okafor')], () => json({ error: 'Code already in use' }, 409));
    const user = userEvent.setup();

    renderScreen(<ShortLinks />, signedIn);
    await screen.findByText('My links');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Code already in use')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repoint' })).toBeInTheDocument();
  });
});
