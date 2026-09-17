import { RECORD_TYPES, type RecordType } from '../grid-url';
import { buildSearchQuery } from '../unified-search.service';
import { RECORD_TYPE_CONFIGS, recordConfig, type RecordTypeConfig } from './index';

/** Every filter id a record type can put on the wire: its column filters and its panel fields. */
function filterIdsOf(config: RecordTypeConfig): string[] {
  const ids = config.columns
    .filter((column) => column.filter === 'text' || column.filter === 'values')
    .map((column) => column.filterId ?? column.key);
  return [...new Set([...ids, ...config.advancedFields.map((field) => field.id)])];
}

describe('record types', () => {
  it('registers one config per record type, keyed by its own id', () => {
    expect(Object.keys(RECORD_TYPE_CONFIGS).sort()).toEqual([...RECORD_TYPES].sort());
    for (const id of RECORD_TYPES) {
      expect(recordConfig(id).id).toBe(id);
    }
  });

  it('sends no record type with a selection column', () => {
    for (const id of RECORD_TYPES) {
      expect(recordConfig(id).selectable)
        .withContext(`${id} is selectable`)
        .toBeFalse();
    }
  });

  it('names a distinct dataset per record type', () => {
    const datasets = RECORD_TYPES.map((id) => recordConfig(id).dataset);
    expect(datasets).toEqual(['Project', 'Document', 'RecentActivity', 'ProjectNotification']);
  });

  const EXPECTED_FILTER_IDS: Record<RecordType, string[]> = {
    projects: [
      'nameContains',
      'proponent',
      'type',
      'region',
      'currentPhaseName',
      'dateUpdatedStart',
      'dateUpdatedEnd',
      'decisionDateStart',
      'decisionDateEnd',
      'eacDecision',
      'CEAAInvolvement',
    ],
    documents: [
      'nameContains',
      'type',
      'milestone',
      'projectPhase',
      'documentAuthorType',
      'datePostedStart',
      'datePostedEnd',
      'legislation',
      'isFeatured',
    ],
    activities: ['type', 'dateAddedStart', 'dateAddedEnd', 'documentUrl'],
    notifications: ['type', 'region', 'pcp', 'decision'],
  };

  for (const id of RECORD_TYPES) {
    it(`puts every ${id} filter id on the wire as and[<id>]=`, () => {
      const config = recordConfig(id);
      const ids = filterIdsOf(config);

      // Pinned, so a filter silently dropped from a config fails here rather than passing an
      // assertion that only checks what the config still holds.
      expect(ids).toEqual(EXPECTED_FILTER_IDS[id]);

      const filters = Object.fromEntries(ids.map((filterId) => [filterId, `v-${filterId}`]));
      const query = buildSearchQuery({
        dataset: config.dataset,
        keywords: 'site',
        pageNum: 1,
        pageSize: 25,
        sortBy: config.defaultSort,
        filters,
      });

      for (const filterId of ids) {
        expect(query)
          .withContext(`${id} is missing and[${filterId}]`)
          .toContain(`&and[${filterId}]=v-${filterId}`);
      }
      expect(query.startsWith(`search?dataset=${config.dataset}&keywords=site`)).toBeTrue();
      expect(query.endsWith('&fuzzy=false')).toBeTrue();
    });
  }
});
