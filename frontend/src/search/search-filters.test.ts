import { toWireFilters, yearOptions } from './search-filters';

describe('toWireFilters', () => {
  it('joins a multi-pick filter into one comma-separated value', () => {
    expect(toWireFilters({ type: ['a', 'b'], region: 'Peace' })).toEqual({
      type: 'a,b',
      region: 'Peace',
    });
  });

  it('leaves an empty pick off the wire', () => {
    expect(toWireFilters({ type: [], region: '' })).toEqual({});
  });

  it('sends a chosen year as the range the index takes', () => {
    expect(toWireFilters({ dateUpdated: '2018' }, ['dateUpdated'])).toEqual({
      dateUpdatedStart: '2018-01-01',
      dateUpdatedEnd: '2018-12-31',
    });
  });

  it('leaves off the wire a year that is not four digits', () => {
    for (const year of ['abc', '20181', '2018,2019', '2018-01-01']) {
      expect(toWireFilters({ dateUpdated: year }, ['dateUpdated']), year).toEqual({});
    }
  });

  it('leaves a bound the advanced panel already set alone', () => {
    expect(
      toWireFilters({ dateUpdated: '2018', dateUpdatedStart: '2018-06-01' }, ['dateUpdated']),
    ).toEqual({
      dateUpdatedStart: '2018-06-01',
      dateUpdatedEnd: '2018-12-31',
    });
  });

  it('trims and percent-encodes a typed name, which is one value rather than a list', () => {
    expect(toWireFilters({ nameContains: ' Site C & D ' }, [], ['nameContains'])).toEqual({
      nameContains: 'Site%20C%20%26%20D',
    });
  });

  it('drops a typed name the reader cleared, which would otherwise narrow to nothing', () => {
    expect(toWireFilters({ nameContains: '   ' }, [], ['nameContains'])).toEqual({});
  });
});

describe('yearOptions', () => {
  const thisYear = new Date().getFullYear();

  it('offers this year back to the first Act, newest first', () => {
    const options = yearOptions('');

    expect(options[0]).toEqual({ value: String(thisYear), label: String(thisYear) });
    expect(options[options.length - 1].value).toBe('1995');
    expect(options.length).toBe(thisYear - 1995 + 1);
  });

  it('keeps a chosen year from outside the range, in order', () => {
    const options = yearOptions('1990');

    expect(options[options.length - 1].value).toBe('1990');
    expect(options.length).toBe(thisYear - 1995 + 2);
  });

  it('does not repeat a chosen year the range already offers', () => {
    expect(yearOptions('2018').filter((option) => option.value === '2018').length).toBe(1);
  });
});
