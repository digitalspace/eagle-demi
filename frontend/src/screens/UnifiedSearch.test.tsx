import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import type { AppConfig } from '../config';
import type { SavedQuery } from '../api/me';
import { ANONYMOUS_SESSION, SessionContext } from '../session/session';
import { NARROW_QUERY } from '../search/grid/DisplayGrid';
import { resetCountsProbe } from '../search/search-api';
import { trackException } from '../telemetry';
import { stubNarrow } from '../test-setup';
import { json } from '../test-http';
import { withQueryClient } from '../test-query';
import { UnifiedSearch } from './UnifiedSearch';

const flags: AppConfig = {};
vi.mock('../config', async (original) => ({
  ...(await original<typeof import('../config')>()),
  config: () => flags,
}));
vi.mock('../telemetry', async (original) => ({
  ...(await original<typeof import('../telemetry')>()),
  trackException: vi.fn(),
}));

const DOCUMENTS = [
  { _id: 'doc-1', displayName: 'Site C Application', datePosted: '2024-03-01T00:00:00Z' },
  { _id: 'doc-2', displayName: 'Ajax Decision', datePosted: '2023-06-01T00:00:00Z' },
];

/** No `ProjectNotification`: the endpoint omits a type it could not measure. */
const COUNTS = { Project: 3, Document: 9, RecentActivity: 0 };

const envelope = (rows: unknown[], total = rows.length) =>
  json([{ searchResults: rows, meta: [{ searchResultsTotal: total }] }]);

const SAVED: SavedQuery[] = [
  { slug: 'dam-decisions', name: 'Dam decisions', params: 'record=activities&keywords=dam', savedAt: '2026-01-01T00:00:00Z' },
];

/**
 * Answers each read the page makes by what it asks for. `rows` overrides a dataset's answer;
 * `saveError` and `deleteError` refuse those writes with that server message; `total` is the
 * document total the envelope reports.
 */
function stubApi(rows: Record<string, unknown[]> = {}, { saveError = '', deleteError = '', total = 0 } = {}) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/me/data')) return json({ queries: SAVED });
    if (url.includes('/me/queries') && init?.method === 'DELETE' && deleteError) return json({ error: deleteError }, 500);
    if (url.includes('/me/queries')) return saveError ? json({ error: saveError }, 409) : json({});
    if (url.includes('/search/counts')) return json([{ counts: COUNTS }]);
    if (url.includes('/download')) return json({ url: 'https://objects.example/presigned' });
    const dataset = /dataset=(\w+)/.exec(url)?.[1] ?? '';
    if (dataset === 'Document') return envelope(rows['Document'] ?? DOCUMENTS, total || undefined);
    return envelope(rows[dataset] ?? []);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Search requests for one dataset, as path and query. */
const searchesFor = (fetchMock: ReturnType<typeof stubApi>, dataset: string) =>
  fetchMock.mock.calls
    .map(([input]) => decodeURIComponent(String(input)))
    .filter((url) => url.includes(`/search?dataset=${dataset}&`));

/** Requests to one path, with the method and body each was sent with. */
const callsTo = (fetchMock: ReturnType<typeof stubApi>, path: string) =>
  fetchMock.mock.calls
    .filter(([input]) => String(input).includes(path))
    .map(([input, init]) => ({ url: String(input), ...init }));

function renderAt(url: string) {
  const router = createMemoryRouter([{ path: '/search', Component: UnifiedSearch }], { initialEntries: [url] });
  // Signed in, so the toolbar reads the saved queries.
  render(
    withQueryClient(
      <SessionContext.Provider value={{ ...ANONYMOUS_SESSION, authenticated: true }}>
        <RouterProvider router={router} />
      </SessionContext.Provider>,
    ),
  );
  return { search: () => new URLSearchParams(router.state.location.search) };
}

// The first render in a worker pays for compiling React and the whole grid, which on a loaded
// machine outlasts findBy's 1 s wait in whichever test runs first. One render here moves that cost
// out of the tests.
beforeAll(async () => {
  stubNarrow(false);
  stubApi();
  renderAt('/search');
  await screen.findByRole('button', { name: 'Site C Application' }, { timeout: 30_000 });
  cleanup();
  vi.unstubAllGlobals();
}, 60_000);

beforeEach(() => {
  resetCountsProbe();
  // jsdom implements neither dialog method nor ResizeObserver.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Cleared so a trace assertion sees only calls its own test made.
  vi.mocked(trackException).mockClear();
  for (const key of Object.keys(flags)) delete flags[key];
});

describe('UnifiedSearch', () => {
  it('lists the documents the search answered, linked by name', async () => {
    stubApi();
    renderAt('/search');

    expect(await screen.findByRole('button', { name: 'Site C Application' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ajax Decision' })).toBeTruthy();
    expect(await screen.findByText('1–2 of 2 documents')).toBeTruthy();
  });

  it('badges each tab with the count the endpoint answered, and no badge on an unknown one', async () => {
    stubApi();
    renderAt('/search');

    const tabs = within(screen.getByRole('group', { name: 'Record type' }));
    expect(await tabs.findByRole('button', { name: /Documents\s*9/ })).toBeTruthy();
    expect(tabs.getByRole('button', { name: /Projects\s*3/ })).toBeTruthy();
    expect(tabs.getByRole('button', { name: /Activities & updates\s*0/ })).toBeTruthy();
    const unknown = tabs.getByRole('button', { name: /^Project notifications/ });
    expect(unknown.querySelector('.unified-search__pill-count')).toBeNull();
  });

  it('keeps the keyword and drops the filters and sort when the record type changes', async () => {
    stubApi();
    const user = userEvent.setup();
    const { search } = renderAt('/search?keywords=dam&type=abc&sortBy=%2BdisplayName');
    await screen.findByRole('button', { name: 'Site C Application' });

    await user.click(screen.getByRole('button', { name: /^Projects/ }));

    expect(search().get('record')).toBe('projects');
    expect(search().get('keywords')).toBe('dam');
    expect(search().get('type')).toBeNull();
    expect(search().get('sortBy')).toBe('-dateUpdated');
  });

  it('sends the typed keyword only once typing has stopped for 300 ms', async () => {
    const fetchMock = stubApi();
    const { search } = renderAt('/search');
    await screen.findByRole('button', { name: 'Site C Application' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'site c' } });
      const typed = (url: string) => url.includes('keywords=site c');

      await act(() => vi.advanceTimersByTimeAsync(299));
      expect(search().get('keywords')).toBeNull();
      expect(searchesFor(fetchMock, 'Document').some(typed)).toBe(false);

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(search().get('keywords')).toBe('site c');
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(searchesFor(fetchMock, 'Document').at(-1)).toContain('&keywords=site c&');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a one-character keyword out of the search', async () => {
    const fetchMock = stubApi();
    renderAt('/search?keywords=s');
    await screen.findByRole('button', { name: 'Site C Application' });

    expect(searchesFor(fetchMock, 'Document').every((url) => !url.includes('keywords='))).toBe(true);
  });

  it('returns to page one when a column filter narrows the set', async () => {
    stubApi({ Document: DOCUMENTS });
    const user = userEvent.setup();
    const { search } = renderAt('/search?currentPage=3');
    await screen.findByRole('button', { name: 'Site C Application' });

    await user.type(screen.getByRole('textbox', { name: 'Filter by Name' }), 'ajax');

    await waitFor(() => expect(search().get('nameContains')).toBe('ajax'));
    expect(search().get('currentPage')).toBeNull();
  });

  it('removes a filter through its chip', async () => {
    stubApi();
    const user = userEvent.setup();
    const { search } = renderAt('/search?nameContains=ajax');

    await user.click(await screen.findByRole('button', { name: 'Remove Name ajax' }));

    expect(search().get('nameContains')).toBeNull();
  });

  it('clears the keyword through its chip and keeps it cleared once typing would have settled', async () => {
    const fetchMock = stubApi();
    const user = userEvent.setup();
    const { search } = renderAt('/search?keywords=dam');
    await screen.findByRole('button', { name: 'Site C Application' });
    const before = searchesFor(fetchMock, 'Document').length;

    await user.click(screen.getByRole('button', { name: 'Remove Search dam' }));
    // Past the debounce, so a draft still holding the old word would have written it back.
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));

    expect(search().get('keywords')).toBeNull();
    expect(searchesFor(fetchMock, 'Document').slice(before).filter((url) => url.includes('keywords=dam'))).toEqual([]);
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  });

  it('hides the scope switch where the environment cannot search inside the documents', async () => {
    stubApi();
    renderAt('/search');
    await screen.findByRole('button', { name: 'Site C Application' });

    expect(screen.queryByRole('group', { name: 'Search documents by' })).toBeNull();
  });

  it('prompts rather than asking the chunk dataset without a keyword', async () => {
    flags['CONTENT_SEARCH'] = true;
    const fetchMock = stubApi();
    renderAt('/search?scope=inside');

    expect(await screen.findByText('Search inside the documents')).toBeTruthy();
    expect(searchesFor(fetchMock, 'DocumentChunk')).toEqual([]);
  });

  it('asks the chunk dataset and draws its passages inside the documents', async () => {
    flags['CONTENT_SEARCH'] = true;
    const fetchMock = stubApi({
      DocumentChunk: [
        {
          documentId: 'doc-9',
          documentName: 'Caribou Plan',
          matchCount: 1,
          passages: [{ text: 'caribou <mark>habitat</mark>', pageNumber: 4, pageNumbered: true }],
        },
      ],
    });
    renderAt('/search?scope=inside&keywords=habitat');

    expect(await screen.findByText('Page 4')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Caribou Plan' })).toBeTruthy();
    expect(searchesFor(fetchMock, 'DocumentChunk').at(-1)).toContain('&sortBy=-score&');
  });

  it('keeps expanded passages open when the page draws again', async () => {
    flags['CONTENT_SEARCH'] = true;
    const passages = [1, 2, 3].map((page) => ({ text: `caribou habitat ${page}`, pageNumber: page, pageNumbered: true }));
    stubApi({ DocumentChunk: [{ documentId: 'doc-9', documentName: 'Caribou Plan', matchCount: 3, passages }] });
    renderAt('/search?scope=inside&keywords=habitat');

    fireEvent.click(await screen.findByRole('button', { name: '1 more passage' }));
    // A keystroke draws the page again before the new word is sent.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'habitats' } });

    expect(screen.getByRole('button', { name: 'Show fewer passages' })).toBeTruthy();
  });

  it('draws the index markup as one highlight and any other markup as plain text', async () => {
    flags['CONTENT_SEARCH'] = true;
    const attack = '<img src=x onerror=alert(1)>';
    stubApi({
      DocumentChunk: [
        {
          documentId: 'doc-9',
          documentName: `${attack} Plan`,
          matchCount: 2,
          passages: [
            { text: 'caribou <mark>habitat</mark>', pageNumber: 4, pageNumbered: true },
            { text: `${attack} upland`, pageNumber: 5, pageNumbered: true },
          ],
        },
      ],
    });
    renderAt('/search?scope=inside&keywords=habitat');
    await screen.findByText('Page 4');

    const hits = document.querySelectorAll('mark.display-grid__hit');
    expect([...hits].map((hit) => hit.textContent)).toEqual(['habitat']);
    expect(document.body.textContent).not.toContain('<mark>');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('heading', { name: `${attack} Plan` })).toBeTruthy();
  });

  it('pages through the results and restarts at page one on a new page size', async () => {
    const fetchMock = stubApi({}, { total: 60 });
    const user = userEvent.setup();
    const { search } = renderAt('/search');
    await screen.findByRole('button', { name: 'Site C Application' });

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(search().get('currentPage')).toBe('2');
    await waitFor(() => expect(searchesFor(fetchMock, 'Document').at(-1)).toContain('&pageNum=1&pageSize=25'));

    await user.click(screen.getByRole('button', { name: '50' }));
    expect(search().get('pageSize')).toBe('50');
    expect(search().get('currentPage')).toBeNull();
    await waitFor(() => expect(searchesFor(fetchMock, 'Document').at(-1)).toContain('&pageNum=0&pageSize=50'));
  });

  it('sorts by a column header and flips the direction on a second press', async () => {
    stubApi();
    const user = userEvent.setup();
    const { search } = renderAt('/search');
    const header = within((await screen.findAllByRole('columnheader')).find((cell) => cell.textContent?.startsWith('Name')) as HTMLElement);

    await user.click(header.getByRole('button'));
    expect(search().get('sortBy')).toBe('+displayName');
    await user.click(header.getByRole('button'));
    expect(search().get('sortBy')).toBe('-displayName');
  });

  it('sends a sort the record cannot use as its own default, and encodes the sign', async () => {
    const fetchMock = stubApi();
    renderAt('/search?sortBy=%2Bbogus');
    await screen.findByRole('button', { name: 'Site C Application' });
    const raw = () => fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('dataset=Document&'));

    expect(raw().at(-1)).toContain('&sortBy=-datePosted');
    expect(raw().some((url) => url.includes('bogus'))).toBe(false);
  });

  it('sends a plus sort encoded, so it does not arrive as a space', async () => {
    const fetchMock = stubApi();
    renderAt('/search?sortBy=%2BdisplayName');
    await screen.findByRole('button', { name: 'Site C Application' });

    const raw = fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('dataset=Document&'));
    expect(raw.at(-1)).toContain('&sortBy=%2BdisplayName');
  });

  it('keeps the last rows and badges up when a search fails, with no empty message', async () => {
    const fetchMock = stubApi();
    renderAt('/search');
    await screen.findByRole('button', { name: 'Site C Application' });
    const tabs = within(screen.getByRole('group', { name: 'Record type' }));
    await tabs.findByRole('button', { name: /Documents\s*9/ });
    fetchMock.mockImplementation(async () => json({ error: 'The index is down' }, 400));
    // The typed keyword goes out after the 300 ms debounce; run that clock rather than wait it out.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'dam' } });
    await act(() => vi.advanceTimersByTimeAsync(300));
    await act(() => vi.advanceTimersByTimeAsync(0));
    vi.useRealTimers();

    expect(await screen.findByText('The index is down')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Site C Application' })).toBeTruthy();
    expect(screen.getByText('1–2 of 2 documents matching')).toBeTruthy();
    expect(tabs.getByRole('button', { name: /Documents\s*9/ })).toBeTruthy();
    expect(document.querySelector('.display-grid__empty')).toBeNull();
  });

  it('shows the failure rather than an empty message when the first search fails', async () => {
    const fetchMock = stubApi();
    fetchMock.mockImplementation(async () => json({ error: 'The index is down' }, 400));
    renderAt('/search');

    expect(await screen.findByText('The index is down')).toBeTruthy();
    expect(screen.queryByText('No documents found')).toBeNull();
  });

  it('drops a column filter still waiting to send when Clear all is pressed', async () => {
    stubApi();
    const { search } = renderAt('/search?keywords=dam');
    await screen.findByRole('button', { name: 'Site C Application' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by Name' }), { target: { value: 'aj' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await act(() => vi.advanceTimersByTimeAsync(400));

    expect(search().get('nameContains')).toBeNull();
    expect(search().get('keywords')).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Filter by Name' }) as HTMLInputElement).value).toBe('');
  });

  it('drops panel text still waiting to send when the record type changes', async () => {
    stubNarrow(true);
    stubApi();
    const { search } = renderAt('/search');
    await screen.findByRole('button', { name: 'Site C Application' });
    fireEvent.click(screen.getByRole('button', { name: 'More filters' }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const panel = within(screen.getByLabelText('Advanced filters'));
    fireEvent.change(panel.getByRole('textbox', { name: 'Name' }), { target: { value: 'aj' } });
    fireEvent.click(screen.getByRole('button', { name: /^Projects/ }));
    await act(() => vi.advanceTimersByTimeAsync(400));

    expect(search().get('record')).toBe('projects');
    expect(search().get('nameContains')).toBeNull();
  });

  it('keeps a trailing comma in typed filter text once it has been sent', async () => {
    stubApi();
    const { search } = renderAt('/search');
    await screen.findByRole('button', { name: 'Site C Application' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const name = screen.getByRole('textbox', { name: 'Filter by Name' }) as HTMLInputElement;

    fireEvent.change(name, { target: { value: 'Smith,' } });
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(search().get('nameContains')).toBe('Smith,');
    expect(name.value).toBe('Smith,');
  });

  it('keeps only the filters the record declares, off the chips and off the request', async () => {
    const fetchMock = stubApi();
    renderAt('/search?utm_source=x&x%26pageSize%3D5000=1&nameContains=ajax');
    await screen.findByRole('button', { name: 'Remove Name ajax' });

    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
    const sent = fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('dataset=Document&'));
    expect(sent.at(-1)).toContain('and[nameContains]=ajax');
    expect(sent.filter((url) => url.includes('utm_source') || url.includes('pageSize=5000'))).toEqual([]);
  });

  it('removes the pick whose chip was pressed when two list entries share a name', async () => {
    const amendment = (id: string) => ({ _id: id, name: 'Amendment', type: 'doctype' });
    stubApi({ List: [amendment('l1'), amendment('l2')] });
    const user = userEvent.setup();
    const { search } = renderAt('/search?type=l1,l2');

    const chips = await screen.findAllByRole('button', { name: 'Remove Document type Amendment' });
    expect(chips).toHaveLength(2);
    await user.click(chips[1]);

    expect(search().get('type')).toBe('l1');
  });

  it('empties a date field when its chip is removed', async () => {
    stubApi();
    const user = userEvent.setup();
    const { search } = renderAt('/search');
    await screen.findByRole('button', { name: 'Site C Application' });
    await user.click(screen.getByRole('button', { name: 'More filters' }));
    const from = within(screen.getByLabelText('Advanced filters')).getByRole('textbox', { name: /Posted from/ }) as HTMLInputElement;

    await user.type(from, '2024-01-15');
    await waitFor(() => expect(search().get('datePostedStart')).toBe('2024-01-15'));
    await user.click(screen.getByRole('button', { name: /^Remove Posted from/ }));

    expect(search().get('datePostedStart')).toBeNull();
    expect(from.value).toBe('');
  });

  describe('record detail', () => {
    const sheet = () => screen.getByRole('dialog', { hidden: true });

    it('opens the sheet when a document name is pressed, and downloads only from inside it', async () => {
      const fetchMock = stubApi();
      const open = vi.fn();
      vi.stubGlobal('open', open);
      const user = userEvent.setup();
      renderAt('/search');

      const name = await screen.findByRole('button', { name: 'Site C Application' });
      await user.click(name);

      expect(within(sheet()).getByRole('heading', { name: 'Site C Application' })).toBeTruthy();
      expect(open).not.toHaveBeenCalled();

      await user.click(within(sheet()).getByRole('button', { name: 'Download' }));
      await waitFor(() => expect(open).toHaveBeenCalledWith('https://objects.example/presigned', '_blank', 'noopener'));
      expect(callsTo(fetchMock, '/documents/doc-1/download')).toHaveLength(1);

      await user.click(within(sheet()).getByRole('button', { name: 'Close' }));
      expect(document.activeElement).toBe(name);
    });

    it('opens the pressed row from any plain cell, with its date as a field', async () => {
      stubApi();
      const user = userEvent.setup();
      renderAt('/search');

      const row = (await screen.findByRole('button', { name: 'Ajax Decision' })).closest('tr') as HTMLElement;
      await user.click(row.querySelector('.display-grid__cell--date') as HTMLElement);

      expect(within(sheet()).getByRole('heading', { name: 'Ajax Decision' })).toBeTruthy();
      expect(within(sheet()).getByText('Date posted')).toBeTruthy();
    });

    it('gives a list row with no page a name button that opens the sheet', async () => {
      stubApi({ RecentActivity: [{ _id: 'a1', headline: 'Dam update', content: 'Work begins.' }] });
      const user = userEvent.setup();
      renderAt('/search?record=activities');

      await user.click(await screen.findByRole('button', { name: 'Dam update' }));

      expect(within(sheet()).getByRole('heading', { name: 'Dam update' })).toBeTruthy();
    });

    it('gives a phone card for a document a name button that opens the sheet', async () => {
      stubNarrow(true);
      stubApi();
      const user = userEvent.setup();
      renderAt('/search');

      const name = await screen.findByRole('button', { name: 'Site C Application' });
      expect(name.closest('.display-grid__card')).not.toBeNull();
      await user.click(name);

      expect(within(sheet()).getByRole('button', { name: 'Download' })).toBeTruthy();
    });

    it('leaves a modified press on the name alone', async () => {
      stubApi();
      const user = userEvent.setup();
      renderAt('/search');

      await user.keyboard('{Control>}');
      await user.click(await screen.findByRole('button', { name: 'Site C Application' }));
      await user.keyboard('{/Control}');

      expect(screen.queryByRole('heading', { name: 'Site C Application', hidden: true })).toBeNull();
    });
  });

  // The popup is a plain group, not a menu, so the button reports open or shut and names no popup type.
  it.each([
    ['Columns', 'Columns shown'],
    ['Saved queries', 'Saved queries'],
  ])('reports the %s popup as expanded without claiming a menu', async (name, group) => {
    stubApi();
    const user = userEvent.setup();
    renderAt('/search');

    const toggle = await screen.findByRole('button', { name });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.hasAttribute('aria-haspopup')).toBe(false);
    expect(screen.getByRole('group', { name: group })).toBeTruthy();
  });

  describe('saved queries', () => {
    it('saves the address as it stands under the typed name, then hands focus back', async () => {
      const fetchMock = stubApi();
      const user = userEvent.setup();
      renderAt('/search?keywords=dam');

      const opener = await screen.findByRole('button', { name: 'Save this query' });
      await user.click(opener);
      const save = screen.getByRole('button', { name: 'Save', hidden: true });
      expect((save as HTMLButtonElement).disabled).toBe(true);

      await user.type(screen.getByLabelText('Name'), '  Dams  ');
      await user.click(save);

      await waitFor(() => expect(document.activeElement).toBe(opener));
      const [put] = callsTo(fetchMock, '/me/queries');
      expect(put.method).toBe('PUT');
      expect(JSON.parse(String(put.body))).toEqual({ name: 'Dams', params: 'keywords=dam' });
    });

    it('keeps the dialog open and says why when the save is refused', async () => {
      stubApi({}, { saveError: 'A query with that name exists' });
      const user = userEvent.setup();
      renderAt('/search');

      await user.click(await screen.findByRole('button', { name: 'Save this query' }));
      await user.type(screen.getByLabelText('Name'), 'Dams');
      await user.click(screen.getByRole('button', { name: 'Save', hidden: true }));

      expect((await screen.findByRole('alert', { hidden: true })).textContent).toBe('A query with that name exists');
      expect(screen.getByLabelText('Name')).toBeTruthy();
    });

    it('says why a saved query could not be deleted', async () => {
      stubApi({}, { deleteError: 'Delete refused' });
      const user = userEvent.setup();
      renderAt('/search');

      await user.click(await screen.findByRole('button', { name: 'Saved queries' }));
      const menu = within(screen.getByRole('group', { name: 'Saved queries' }));
      await user.click(await menu.findByRole('button', { name: 'Delete Dam decisions' }));

      expect((await menu.findByRole('alert')).textContent).toBe('Delete refused');
    });

    it('lists a saved query under its record type, sends its delete, and opens it', async () => {
      const fetchMock = stubApi();
      const user = userEvent.setup();
      const { search } = renderAt('/search');

      await user.click(await screen.findByRole('button', { name: 'Saved queries' }));
      const menu = within(screen.getByRole('group', { name: 'Saved queries' }));
      await user.click(await menu.findByRole('button', { name: 'Delete Dam decisions' }));
      await waitFor(() => expect(callsTo(fetchMock, '/me/queries/dam-decisions').map((call) => call.method)).toEqual(['DELETE']));

      const open = menu.getByText('Dam decisions').closest('button') as HTMLElement;
      expect(within(open).getByText('Activities & updates')).toBeTruthy();
      await user.click(open);
      expect(search().get('record')).toBe('activities');
      expect(search().get('keywords')).toBe('dam');
      expect(screen.getByRole('searchbox')).toHaveValue('dam');
      expect(screen.queryByRole('group', { name: 'Saved queries' })).toBeNull();
    });
  });

  describe('search help and tour', () => {
    it('opens the help, reports it open, and hands focus back on close', async () => {
      stubApi();
      const user = userEvent.setup();
      renderAt('/search');

      const help = await screen.findByRole('button', { name: 'Search help' });
      await user.click(help);
      expect(help.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('heading', { name: 'Every word counts', hidden: true })).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Close search help', hidden: true }));
      expect(help.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(help);
    });

    it('walks the controls on the page from Take the tour, and Escape ends it back on the help button', async () => {
      stubApi();
      const user = userEvent.setup();
      renderAt('/search');

      const help = await screen.findByRole('button', { name: 'Search help' });
      await user.click(help);
      await user.click(screen.getByRole('button', { name: 'Take the tour', hidden: true }));

      const card = await screen.findByRole('dialog', { name: 'One search box' });
      expect(within(card).getByText(/^Step 1 of \d+$/)).toBeTruthy();
      expect(document.activeElement).toBe(card);
      // Everything but the tour and the lit control is out of reach.
      expect(help.closest('[inert]')).not.toBeNull();

      await user.click(within(card).getByRole('button', { name: 'Next' }));
      expect(screen.getByRole('dialog', { name: 'Pick a record type' })).toBeTruthy();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: 'Pick a record type' })).toBeNull();
      expect(help.closest('[inert]')).toBeNull();
      expect(document.activeElement).toBe(help);
    });
  });

  it('gives the notifications panel every column filter, the layout having no row for them', async () => {
    stubApi();
    const user = userEvent.setup();
    renderAt('/search?record=notifications');

    await user.click(await screen.findByRole('button', { name: 'More filters' }));

    const panel = within(screen.getByLabelText('Advanced filters'));
    expect(panel.getByLabelText('Project type')).toBeTruthy();
    expect(panel.getByLabelText('Notification decision')).toBeTruthy();
  });

  it('leaves the name filter off a search inside the documents, which cannot take it', async () => {
    flags['CONTENT_SEARCH'] = true;
    const fetchMock = stubApi({
      DocumentChunk: [{ documentId: 'doc-9', documentName: 'Caribou Plan', matchCount: 1, passages: [{ text: 'habitat' }] }],
    });
    renderAt('/search?scope=inside&keywords=habitat&nameContains=ajax');
    await screen.findByText('Passage 1');

    expect(searchesFor(fetchMock, 'DocumentChunk').at(-1)).not.toContain('nameContains');
    expect(screen.queryByRole('button', { name: /^Remove Name/ })).toBeNull();
  });

  it('lays out by its own breakpoint, not the shell one', async () => {
    // Narrow for the shell, wide for the grid: a 800px window.
    window.matchMedia = (media: string) =>
      ({ matches: media !== NARROW_QUERY, media, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList;
    stubApi();
    renderAt('/search');

    const name = await screen.findByRole('button', { name: 'Site C Application' });
    expect(name.closest('table')).not.toBeNull();
  });

  it('leaves the fields a document does not carry off its phone card', async () => {
    stubNarrow(true);
    stubApi({ Document: [{ _id: 'doc-1', displayName: 'Site C Application', milestone: 'Application' }] });
    renderAt('/search');

    const card = (await screen.findByRole('button', { name: 'Site C Application' })).closest('.display-grid__card') as HTMLElement;
    expect([...card.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Milestone']);
  });

  it('keeps a locked column on screen when the address hides it', async () => {
    stubApi();
    renderAt('/search?cols=displayName,milestone');
    await screen.findByRole('button', { name: 'Site C Application' });

    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent ?? '');
    expect(headers.some((text) => text.startsWith('Name'))).toBe(true);
    expect(headers.some((text) => text.startsWith('Milestone'))).toBe(false);
  });

  it('marks the sort in force on the header, not a sort the address named and the record cannot use', async () => {
    stubApi();
    renderAt('/search?sortBy=%2Bbogus');

    const headers = await screen.findAllByRole('columnheader');
    const sorted = headers.filter((cell) => cell.getAttribute('aria-sort'));
    expect(sorted.map((cell) => [cell.textContent?.replace(/[▲▼⇅]/g, ''), cell.getAttribute('aria-sort')])).toEqual([
      ['Date posted', 'descending'],
    ]);
  });

  it('counts only the filters the record declares when it says why nothing matched', async () => {
    stubApi({ Document: [] });
    renderAt('/search?utm_source=x');

    expect(await screen.findByText('No documents found')).toBeTruthy();
  });

  it('offers no chip for a year the address spells wrong, and drops it from the address', async () => {
    const fetchMock = stubApi();
    const { search } = renderAt('/search?datePosted=abc&keywords=dam');
    await screen.findByRole('button', { name: 'Site C Application' });

    expect(screen.queryByRole('button', { name: /^Remove Date posted/ })).toBeNull();
    expect(searchesFor(fetchMock, 'Document').some((url) => url.includes('abc'))).toBe(false);
    await waitFor(() => expect(search().get('datePosted')).toBeNull());
    expect(search().get('keywords')).toBe('dam');
  });

  it('moves a page past the last one back to the last page once the total is known', async () => {
    stubApi({}, { total: 60 });
    const { search } = renderAt('/search?currentPage=99');

    await waitFor(() => expect(search().get('currentPage')).toBe('3'));
  });

  it('moves focus to the next chip when one is removed, and to the search box when none is left', async () => {
    stubApi();
    const user = userEvent.setup();
    renderAt('/search?keywords=dam&nameContains=ajax');

    await user.click(await screen.findByRole('button', { name: 'Remove Search dam' }));
    const name = screen.getByRole('button', { name: 'Remove Name ajax' });
    await waitFor(() => expect(name).toHaveFocus());

    await user.click(name);
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus());
  });

  it('moves focus to the search box on Clear all', async () => {
    stubApi();
    const user = userEvent.setup();
    renderAt('/search?nameContains=ajax');

    await user.click(await screen.findByRole('button', { name: 'Clear all' }));

    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus());
  });

  it('says so and traces it when the filter choices cannot be read', async () => {
    const fetchMock = stubApi();
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      String(input).includes('dataset=List') ? json({ error: 'List is down' }, 500) : answer(input, init),
    );
    renderAt('/search');

    expect(await screen.findByText(/Some filter choices could not be loaded/)).toBeTruthy();
    expect(trackException).toHaveBeenCalledWith(expect.anything(), { lookup: 'List' });
  });

  it('says what matched nothing, naming the keyword', async () => {
    stubApi({ Document: [] });
    renderAt('/search?keywords=zzz');

    expect(await screen.findByText('Nothing in documents matches “zzz”')).toBeTruthy();
  });
});
