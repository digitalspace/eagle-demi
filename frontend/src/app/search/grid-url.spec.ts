import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_RECORD,
  DEFAULT_SORT,
  INSIDE_SORT,
  parseGridParams,
  serializeGridParams,
  toApiFilters,
  toggleSortDirection,
} from './grid-url';

describe('grid-url', () => {
  describe('parseGridParams and serializeGridParams', () => {
    it('round-trips a fully populated view', () => {
      const query =
        'keywords=site+c&record=projects&scope=inside&sortBy=%2Bname&currentPage=3&pageSize=50&cols=region%2Ctype&proponent=a%2Cb&nameContains=dam';

      const state = parseGridParams(new URLSearchParams(query));

      expect(state).toEqual({
        keywords: 'site c',
        record: 'projects',
        scope: 'inside',
        sortBy: '+name',
        currentPage: 3,
        pageSize: 50,
        hiddenColumns: ['region', 'type'],
        filters: { proponent: ['a', 'b'], nameContains: 'dam' },
      });

      const back = serializeGridParams(state);
      expect(back.get('keywords')).toBe('site c');
      expect(back.get('record')).toBe('projects');
      expect(back.get('scope')).toBe('inside');
      expect(back.get('sortBy')).toBe('+name');
      expect(back.get('currentPage')).toBe('3');
      expect(back.get('pageSize')).toBe('50');
      expect(back.get('cols')).toBe('region,type');
      expect(back.get('proponent')).toBe('a,b');
      expect(back.get('nameContains')).toBe('dam');
      expect(parseGridParams(back)).toEqual(state);
    });

    it('restores a sort sign that URL decoding turned into a space', () => {
      // `?sortBy=+name` form-decodes to " name", which the API cannot sort by.
      expect(parseGridParams(new URLSearchParams('sortBy= name')).sortBy).toBe('+name');
    });

    it('drops values the schema does not recognise', () => {
      const state = parseGridParams(
        new URLSearchParams('record=vessels&pageSize=7&currentPage=0&blank='),
      );

      expect(state.record).toBe(DEFAULT_RECORD);
      expect(state.pageSize).toBe(DEFAULT_PAGE_SIZE);
      expect(state.currentPage).toBe(1);
      expect(state.filters).toEqual({});
    });

    it('falls back to the default sort when the URL carries none', () => {
      expect(parseGridParams(new URLSearchParams('')).sortBy).toBe(DEFAULT_SORT);
      expect(parseGridParams(new URLSearchParams('sortBy=')).sortBy).toBe(DEFAULT_SORT);
      expect(
        parseGridParams(new URLSearchParams('sortBy='), { defaultSort: '-dateAdded' }).sortBy,
      ).toBe('-dateAdded');
    });

    it('sorts by match count inside documents, whatever the type default is', () => {
      expect(
        parseGridParams(new URLSearchParams('scope=inside'), { defaultSort: '-dateUpdated' })
          .sortBy,
      ).toBe(INSIDE_SORT);
    });

    it('leaves defaults and empty values off the query string', () => {
      const params = serializeGridParams({
        keywords: '',
        record: DEFAULT_RECORD,
        scope: 'names',
        sortBy: DEFAULT_SORT,
        currentPage: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        hiddenColumns: [],
        filters: { proponent: [], region: '' },
      });

      expect(params.toString()).toBe(`sortBy=${encodeURIComponent(DEFAULT_SORT)}`);
    });
  });

  describe('toApiFilters', () => {
    it('wraps each filter id and drops the empty ones', () => {
      expect(toApiFilters({ type: ['a', 'b'], region: 'Peace', milestone: '', phase: [] })).toEqual({
        'and[type]': 'a,b',
        'and[region]': 'Peace',
      });
    });
  });

  describe('toggleSortDirection', () => {
    it('flips the same column and starts a new one at the fallback', () => {
      expect(toggleSortDirection('-datePosted', 'datePosted')).toBe('+datePosted');
      expect(toggleSortDirection('+datePosted', 'datePosted')).toBe('-datePosted');
      expect(toggleSortDirection('-datePosted', 'displayName')).toBe('+displayName');
      expect(toggleSortDirection('-datePosted', 'displayName', '-')).toBe('-displayName');
    });
  });
});
