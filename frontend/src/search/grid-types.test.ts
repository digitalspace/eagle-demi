import { columnFiltersForPanel, passageLabel, sortStateOf, type GridColumn } from './grid-types';

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

describe('passageLabel', () => {
  it('labels a real page number as a page and anything else as a passage', () => {
    expect(passageLabel({ locator: 12, text: 'hit', pageNumbered: true })).toBe('Page 12');
    expect(passageLabel({ locator: 2, text: 'hit' })).toBe('Passage 2');
  });
});
