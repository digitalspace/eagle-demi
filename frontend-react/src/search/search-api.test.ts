import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from '../test-http';
import { trackException } from '../telemetry';
import { buildSearchQuery, passageRowFrom, readCounts, resetCountsProbe, searchKeyword } from './search-api';

vi.mock('../telemetry', () => ({ trackException: vi.fn() }));

const envelope = (total: number) => json([{ searchResults: [{}], meta: [{ searchResultsTotal: total }] }]);

/** Path and query of each request, which is what the wire contract is about. */
const sent = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.map(([input]) => {
    const url = new URL(String(input));
    return url.pathname + url.search;
  });

function stubFetch(answer: (url: string) => Response) {
  const mock = vi.fn(async (input: unknown) => answer(String(input)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => resetCountsProbe());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(trackException).mockClear();
});

describe('searchKeyword', () => {
  it('searches as an empty keyword below two characters', () => {
    expect(searchKeyword(' a ')).toBe('');
    expect(searchKeyword(' ab ')).toBe('ab');
  });
});

describe('buildSearchQuery', () => {
  it('writes the parameters in order, one and[] per comma-separated pick', () => {
    expect(
      buildSearchQuery({
        dataset: 'Document',
        keywords: 'site%20c',
        pageNum: 2,
        pageSize: 25,
        sortBy: '-datePosted',
        filters: { type: 'a,b', region: 'Peace' },
      }),
    ).toBe(
      'search?dataset=Document&keywords=site%20c&pageNum=1&pageSize=25&sortBy=-datePosted' +
        '&and[type]=a&and[type]=b&and[region]=Peace&fuzzy=false',
    );
  });

  it('escapes a filter name, so it cannot add a parameter of its own', () => {
    const query = buildSearchQuery({ dataset: 'Document', keywords: '', pageNum: 1, pageSize: 25, filters: { 'x&pageSize=5000': 'a' } });

    expect(query).toContain('&and[x%26pageSize%3D5000]=a&');
    expect(query).not.toContain('pageSize=5000');
  });

  it('wraps years as a range and a typed name as one value', () => {
    expect(
      buildSearchQuery({
        dataset: 'Project',
        keywords: 'site',
        pageNum: 1,
        pageSize: 25,
        filters: { dateUpdated: '2018', nameContains: 'Site C', type: ['a', 'b'] },
        yearIds: ['dateUpdated'],
        textIds: ['nameContains'],
      }),
    ).toBe(
      'search?dataset=Project&keywords=site&pageNum=0&pageSize=25' +
        '&and[nameContains]=Site%20C&and[type]=a&and[type]=b' +
        '&and[dateUpdatedStart]=2018-01-01&and[dateUpdatedEnd]=2018-12-31&fuzzy=false',
    );
  });

  it('escapes a pick the query string would otherwise swallow or change', () => {
    expect(
      buildSearchQuery({
        dataset: 'Document',
        keywords: '',
        pageNum: 1,
        pageSize: 25,
        filters: { type: 'a#b,c+d', milestone: 'Energy-Petroleum & Natural Gas' },
      }),
    ).toBe(
      'search?dataset=Document&pageNum=0&pageSize=25' +
        '&and[type]=a%23b&and[type]=c%2Bd&and[milestone]=Energy-Petroleum%20%26%20Natural%20Gas' +
        '&fuzzy=false',
    );
  });
});

describe('readCounts', () => {
  it('reads counts from search/counts, keyed by dataset name', async () => {
    const fetchMock = stubFetch(() =>
      json([{ counts: { Project: 3, Document: 9, RecentActivity: null, ProjectNotification: 2 } }]),
    );

    const counts = await readCounts('site c');

    expect(sent(fetchMock)).toEqual(['/api/search/counts?keywords=site%20c']);
    expect(counts).toEqual({ projects: 3, documents: 9, activities: null, notifications: 2 });
  });

  it('falls back to four one-row searches when search/counts answers 404', async () => {
    const fetchMock = stubFetch((url) =>
      url.includes('/search/counts') ? json({ error: 'not found' }, 404) : envelope(7),
    );

    const counts = await readCounts('site');

    expect(sent(fetchMock).slice(1)).toEqual([
      '/api/search?dataset=Project&keywords=site&pageNum=0&pageSize=1&fuzzy=false',
      '/api/search?dataset=Document&keywords=site&pageNum=0&pageSize=1&fuzzy=false',
      '/api/search?dataset=RecentActivity&keywords=site&pageNum=0&pageSize=1&fuzzy=false',
      '/api/search?dataset=ProjectNotification&keywords=site&pageNum=0&pageSize=1&fuzzy=false',
    ]);
    expect(counts).toEqual({ projects: 7, documents: 7, activities: 7, notifications: 7 });
  });

  it('takes the 404 once: the next keyword goes straight to the four searches', async () => {
    const fetchMock = stubFetch((url) =>
      url.includes('/search/counts') ? json({ error: 'not found' }, 404) : envelope(7),
    );
    await readCounts('site');
    fetchMock.mockClear();

    await readCounts('dam');

    expect(sent(fetchMock).filter((url) => url.includes('/search/counts'))).toEqual([]);
  });

  it('keeps the badges of the datasets that answered when one of the four fails', async () => {
    stubFetch((url) => {
      if (url.includes('/search/counts')) return json({ error: 'not found' }, 404);
      return url.includes('dataset=RecentActivity') ? json({ error: 'boom' }, 500) : envelope(7);
    });

    const counts = await readCounts('site');

    expect(counts).toEqual({ projects: 7, documents: 7, activities: null, notifications: 7 });
    expect(trackException).toHaveBeenCalledTimes(1);
  });

  it('rejects a counts failure other than a 404 rather than guessing totals', async () => {
    stubFetch(() => json({ error: 'boom' }, 500));
    await expect(readCounts('site')).rejects.toThrow('boom');
  });
});

describe('passageRowFrom', () => {
  it('reads a grouped DocumentChunk row as one passage row', () => {
    const row = passageRowFrom(
      {
        documentId: 'doc-1',
        documentName: 'Application Part A',
        datePosted: '2024-03-01',
        documentType: 'Application',
        matchCount: 5,
        passages: [
          { text: 'first hit', pageNumber: 12, pageNumbered: true },
          { text: 'second hit', pageNumber: 0, pageNumbered: false },
        ],
      },
      '',
    );

    expect(row.passages).toEqual([
      { locator: 12, text: 'first hit', pageNumbered: true },
      // No real page number, so the locator is the passage's place in what came back.
      { locator: 2, text: 'second hit', pageNumbered: false },
    ]);
    expect(row.id).toBe('doc-1');
    expect(row.total).toBe(5);
  });
});
