import { RECORD_TYPES, type RecordType } from '../grid-url';
import { buildSearchQuery } from '../unified-search.service';
import {
  ATTACHMENTS_FILTER_ID,
  attachmentsFilterDropped,
  isoDay,
  plainText,
  projectOf,
  subjectName,
} from './activities';
import { PROJECTS_FALLBACK_SORT, PROJECTS_SORT, proponentName, resolveSort } from './projects';
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

describe('activities helpers', () => {
  describe('plainText', () => {
    it('returns no markup for content that arrives HTML-encoded', () => {
      // Decoding after a tag strip is what turns this back into a live `<img>`; see
      // RegistryStateService.sanitizeHighlight for the same rule on the highlight path.
      expect(plainText('&lt;img src=x onerror=alert(1)&gt;')).toBe('');
    });

    it('decodes the entities no hand-written table remembers', () => {
      expect(plainText('caf&eacute; &sect;1')).toBe('café §1');
    });

    it('drops the markup and collapses what is left to single spaces', () => {
      expect(plainText('<p>One  update</p>\n<p>  Two </p>')).toBe('One update Two');
    });

    it('reads an empty body as an empty string', () => {
      expect(plainText(null)).toBe('');
    });
  });

  describe('isoDay', () => {
    it('reads a UTC midnight date as its own day, not the previous one', () => {
      expect(isoDay('2024-03-01T00:00:00.000Z')).toBe('2024-03-01');
    });

    it('reads an unparseable date as empty', () => {
      expect(isoDay('not a date')).toBe('');
    });
  });

  describe('projectOf', () => {
    it('reads a populated project', () => {
      expect(projectOf({ project: { _id: 'p1', name: 'Site C' } })).toEqual({
        id: 'p1',
        name: 'Site C',
      });
    });

    it('reads a bare project id as an id with no name', () => {
      expect(projectOf({ project: 'p1' })).toEqual({ id: 'p1', name: '' });
    });
  });

  describe('subjectName', () => {
    it('names the project an update belongs to', () => {
      expect(subjectName({ project: { _id: 'p1', name: 'Site C' }, notificationName: 'Other' })).toBe(
        'Site C',
      );
    });

    it('names the notification where the update has no project', () => {
      expect(subjectName({ project: 'p1', projectNotification: { name: 'Coal Mine s.11' } })).toBe(
        'Coal Mine s.11',
      );
    });
  });

  describe('attachmentsFilterDropped', () => {
    it('is true when the response says the index dropped the attachments field', () => {
      expect(attachmentsFilterDropped([{ dropped: [ATTACHMENTS_FILTER_ID] }])).toBeTrue();
    });

    it('is false when the response drops some other field', () => {
      expect(attachmentsFilterDropped([{ dropped: ['dateUpdated'] }])).toBeFalse();
    });
  });
});

describe('projects helpers', () => {
  describe('resolveSort', () => {
    it('sorts by name when the index dropped the date it sorts on', () => {
      expect(resolveSort([{ dropped: ['dateUpdated'] }])).toBe(PROJECTS_FALLBACK_SORT);
    });

    it('keeps the date sort when the index honoured it', () => {
      expect(resolveSort([{ dropped: ['documentUrl'] }])).toBe(PROJECTS_SORT);
      expect(resolveSort(null)).toBe(PROJECTS_SORT);
    });
  });

  describe('proponentName', () => {
    it('names a populated proponent', () => {
      expect(proponentName({ proponent: { name: 'Acme' } })).toBe('Acme');
    });

    it('names a proponent that arrived as a bare string', () => {
      expect(proponentName({ proponent: 'Acme' })).toBe('Acme');
    });
  });
});

describe('documents helpers', () => {
  it('draws the name cell as a download only where the row carries an id', () => {
    const cell = recordConfig('documents').columns[0].cell;

    expect(cell?.({ _id: 'd1', displayName: 'Application' })).toEqual({
      kind: 'download',
      text: 'Application',
      documentId: 'd1',
    });
    expect(cell?.({ displayName: 'Application' })).toEqual({
      kind: 'text',
      text: 'Application',
    });
  });

  it('offers the legislation years newest first, one per Act', () => {
    const options = recordConfig('documents').optionsFrom(
      [{ legislation: 1996 }, { legislation: 2018 }, { legislation: 2002 }, { legislation: 2018 }],
      [],
    );

    expect(options['legislation']).toEqual([
      { value: '2018', label: '2018 Act' },
      { value: '2002', label: '2002 Act' },
      { value: '1996', label: '1996 Act' },
    ]);
  });
});
