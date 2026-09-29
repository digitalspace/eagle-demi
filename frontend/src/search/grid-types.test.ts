import { columnFiltersForPanel, groupByLegislation, passageLabel, sortStateOf, type GridColumn } from './grid-types';

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

describe('groupByLegislation', () => {
  it('puts the terms with no Act first, then each Act newest first, keeping order within a group', () => {
    const groups = groupByLegislation([
      { value: 'a02', label: 'Amendment', legislation: '2002' },
      { value: 'none1', label: 'Other' },
      { value: 'a18', label: 'Amendment', legislation: '2018' },
      { value: 'p02', label: 'Proponent', legislation: '2002' },
      { value: 'none2', label: 'Misc' },
    ]);

    expect(groups.map((group) => group.legislation)).toEqual(['', '2018', '2002']);
    expect(groups.map((group) => group.options.map((option) => option.value))).toEqual([
      ['none1', 'none2'],
      ['a18'],
      ['a02', 'p02'],
    ]);
  });
});
