import {
  PASSAGE_LOCATOR,
  columnFiltersForPanel,
  sortStateOf,
  type GridColumn,
  type PassageRow,
} from './grid-types';

describe('sortStateOf', () => {
  it('reads a leading minus as a descending sort on the field', () => {
    expect(sortStateOf('-datePosted')).toEqual({ key: 'datePosted', dir: 'desc' });
  });

  it('reads any other sign as ascending', () => {
    expect(sortStateOf('+name')).toEqual({ key: 'name', dir: 'asc' });
  });

  it('reads no sort at all as no sort state', () => {
    expect(sortStateOf('')).toBeNull();
  });
});

describe('columnFiltersForPanel', () => {
  const columns: GridColumn[] = [
    { key: 'displayName', label: 'Name', filter: 'text', filterId: 'nameContains' },
    {
      key: 'type',
      label: 'Document type',
      filter: 'values',
      options: [{ value: 'letter', label: 'Letter' }],
    },
    // The panel carries the record's own date range, so a year column is not repeated in it.
    { key: 'datePosted', label: 'Date posted', filter: 'year' },
    { key: 'summary', label: 'Summary' },
  ];

  it('offers a text column as a typed field under its filter id', () => {
    expect(columnFiltersForPanel(columns)[0]).toEqual({
      id: 'nameContains',
      label: 'Name',
      kind: 'text',
      placeholder: 'Name',
    });
  });

  it('offers a value column as a select carrying that column options', () => {
    expect(columnFiltersForPanel(columns)[1]).toEqual({
      id: 'type',
      label: 'Document type',
      kind: 'select',
      options: [{ value: 'letter', label: 'Letter' }],
    });
  });

  it('offers nothing for a year column or a column with no filter', () => {
    expect(columnFiltersForPanel(columns).length).toBe(2);
  });
});

describe('PASSAGE_LOCATOR', () => {
  const row: PassageRow = {
    id: 'd1',
    name: 'Application Part A',
    href: '/api/documents/d1/download',
    date: null,
    type: null,
    author: null,
    passages: [],
    total: 2,
  };

  it('links into the file at the page a real page number names', () => {
    expect(PASSAGE_LOCATOR.href(row, { locator: 12, text: 'hit', pageNumbered: true })).toBe(
      '/api/documents/d1/download#page=12',
    );
  });

  it('offers no link where the locator is only the passage place in the results', () => {
    expect(PASSAGE_LOCATOR.href(row, { locator: 2, text: 'hit' })).toBeUndefined();
  });

  it('labels a real page number as a page and anything else as a passage', () => {
    expect(PASSAGE_LOCATOR.label({ locator: 12, text: 'hit', pageNumbered: true })).toBe('Page 12');
    expect(PASSAGE_LOCATOR.label({ locator: 2, text: 'hit' })).toBe('Passage 2');
  });
});
