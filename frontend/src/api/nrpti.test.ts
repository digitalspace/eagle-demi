import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useNrptiForProject } from './nrpti';
import { queryWrapper } from '../test-query';
import { json } from '../test-http';

// Eagle ids from the business list: one plain, one whose BCMI mine is mapped by guid, one with fixed record ids.
const BRUCEJACK = '588511caaaecd9001b825bcb';
const BLACKWATER = '588511c0aaecd9001b82522a';
const BLACKWATER_MINE_GUID = '745b65a7-4849-4156-97dc-dc2d5c3f2154';
const GALORE_CREEK = '588510c6aaecd9001b8157d0';

const RECORD_KINDS = [
  'Inspection', 'Order', 'AdministrativePenalty', 'Warning', 'Certificate',
  'Permit', 'Agreement', 'ConstructionPlan', 'ManagementPlan', 'SelfReport',
];

type Rows = Record<string, unknown>[];

interface Answers {
  minesByEagleId?: Rows;
  minesByGuid?: (guid: string) => Rows;
  byProject?: Rows;
  byMine?: (guids: string[]) => Rows;
  byId?: (ids: string[]) => Rows;
}

const page = (rows: Rows, total?: number) =>
  json([{ searchResults: rows, meta: total === undefined ? [] : [{ searchResultsTotal: total }] }]);

/** Answers each NRPTI read by the filter it sends; a read with a filter it does not know gets no rows. */
function stubNrpti(eagleId: string, answers: Answers) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const q = new URL(String(input)).searchParams;
      const dataset = q.get('dataset') ?? '';
      if (dataset === 'MineBCMI') {
        if (q.get('and[_epicProjectIds]') === eagleId) return page(answers.minesByEagleId ?? []);
        if (q.has('and[_sourceRefId]')) return page(answers.minesByGuid?.(q.get('and[_sourceRefId]') ?? '') ?? []);
        return page([]);
      }
      if ([...dataset.split(',')].sort().join() !== [...RECORD_KINDS].sort().join()) return page([]);
      if (q.get('and[_epicProjectId]') === eagleId) return page(answers.byProject ?? []);
      if (q.has('and[mineGuid]')) return page(answers.byMine?.(q.getAll('and[mineGuid]')) ?? []);
      if (q.has('and[_id]')) return page(answers.byId?.(q.getAll('and[_id]')) ?? []);
      return page([]);
    }),
  );
}

function renderNrpti(eagleId: string) {
  const { result } = renderHook(() => useNrptiForProject(eagleId), { wrapper: queryWrapper() });
  return result;
}

const settled = async (result: { current: ReturnType<typeof useNrptiForProject> }) =>
  waitFor(() => expect(result.current.recordsLoading).toBe(false));

const record = (id: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  _schemaName: 'Inspection',
  recordName: `Record ${id}`,
  dateIssued: '2024-01-01T00:00:00.000Z',
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe('useNrptiForProject', () => {
  it('adds the mapped mine read by guid, once per mine', async () => {
    stubNrpti(BLACKWATER, {
      minesByEagleId: [{ _id: 'm1', _sourceRefId: 'g1', name: 'Linked Mine' }],
      minesByGuid: (guid) =>
        guid === BLACKWATER_MINE_GUID
          ? [
              { _id: 'm1', _sourceRefId: 'g1', name: 'Linked Mine' },
              { _id: 'm2', _sourceRefId: BLACKWATER_MINE_GUID, name: 'Blackwater Mine' },
            ]
          : [],
    });

    const result = renderNrpti(BLACKWATER);
    await settled(result);

    expect(result.current.mines.map((mine) => mine.name)).toEqual(['Linked Mine', 'Blackwater Mine']);
  });

  it('reads records by Eagle id, by every mine guid and by listed record id, newest first', async () => {
    stubNrpti(GALORE_CREEK, {
      minesByEagleId: [
        { _id: 'm1', _sourceRefId: 'g1', name: 'North' },
        { _id: 'm2', _sourceRefId: 'g2', name: 'South' },
      ],
      byProject: [record('by-project', { dateIssued: '2019-05-01' })],
      byMine: (guids) => [
        ...(guids.includes('g1') ? [record('by-g1', { dateIssued: '2023-05-01' })] : []),
        ...(guids.includes('g2') ? [record('by-g2', { dateIssued: '2022-05-01' })] : []),
      ],
      byId: (ids) => [
        ...(ids.includes('5f3d784e9524bf00211cc23f') ? [record('5f3d784e9524bf00211cc23f', { dateIssued: '2021-05-01' })] : []),
        ...(ids.includes('5eceb689589694001a08c066') ? [record('5eceb689589694001a08c066', { dateIssued: '2020-05-01' })] : []),
      ],
    });

    const result = renderNrpti(GALORE_CREEK);
    await waitFor(() => expect(result.current.records).toHaveLength(5));

    expect(result.current.records.map((r) => r.id)).toEqual([
      'by-g1',
      'by-g2',
      '5f3d784e9524bf00211cc23f',
      '5eceb689589694001a08c066',
      'by-project',
    ]);
  });

  it('names a record’s kind from its row schema', async () => {
    stubNrpti(BRUCEJACK, { byProject: [record('r1', { _schemaName: 'AdministrativePenalty' })] });

    const result = renderNrpti(BRUCEJACK);
    await settled(result);

    expect(result.current.records[0]?.kind).toBe('Administrative penalty');
  });

  it('leaves out records that came from EPIC', async () => {
    stubNrpti(BRUCEJACK, {
      byProject: [record('from-epic', { sourceSystemRef: 'epic' }), record('from-core', { sourceSystemRef: 'core' })],
    });

    const result = renderNrpti(BRUCEJACK);
    await settled(result);

    expect(result.current.records.map((r) => r.id)).toEqual(['from-core']);
  });

  it('keeps only public documents with a web link', async () => {
    stubNrpti(BRUCEJACK, {
      byProject: [
        record('r1', {
          documents: [
            { _id: 'd1', fileName: 'public-http.pdf', url: 'http://example.org/1.pdf', read: ['public'] },
            { _id: 'd2', fileName: 'public-https.pdf', url: 'https://example.org/2.pdf', read: ['public', 'sysadmin'] },
            { _id: 'd3', fileName: 'staff-only.pdf', url: 'https://example.org/3.pdf', read: ['sysadmin'] },
            { _id: 'd4', fileName: 'script.pdf', url: 'javascript:alert(1)', read: ['public'] },
            { _id: 'd5', fileName: 'relative.pdf', url: '/api/document/5', read: ['public'] },
          ],
        }),
      ],
    });

    const result = renderNrpti(BRUCEJACK);
    await settled(result);

    expect(result.current.records[0]?.documents.map((doc) => doc.fileName)).toEqual([
      'public-http.pdf',
      'public-https.pdf',
    ]);
  });

  it('shows a permit number only when the mine allows it', async () => {
    stubNrpti(BRUCEJACK, {
      minesByEagleId: [
        { _id: 'm1', name: 'Shown', permitNumber: 'C-1', showPermitNumber: true },
        { _id: 'm2', name: 'String flag', permitNumber: 'C-2', showPermitNumber: 'true' },
        { _id: 'm3', name: 'No flag', permitNumber: 'C-3' },
      ],
    });

    const result = renderNrpti(BRUCEJACK);
    await settled(result);

    expect(result.current.mines.map((mine) => mine.permitNumber)).toEqual(['C-1', null, null]);
  });

  it('never carries who a record was issued to or its summary', async () => {
    stubNrpti(BRUCEJACK, {
      byProject: [
        record('r1', {
          issuedTo: { type: 'Individual', fullName: 'Jane Private' },
          summary: 'Jane Private was found on site.',
        }),
      ],
    });

    const result = renderNrpti(BRUCEJACK);
    await settled(result);

    expect(result.current.records).toHaveLength(1);
    expect(JSON.stringify(result.current.records)).not.toContain('Jane Private');
  });

  it('shows a record found by two reads once, and drops rows with no id', async () => {
    stubNrpti(BRUCEJACK, {
      minesByEagleId: [{ _id: 'm1', _sourceRefId: 'g1', name: 'Brucejack' }],
      byProject: [record('shared'), record('')],
      byMine: () => [record('shared')],
    });

    const result = renderNrpti(BRUCEJACK);
    await settled(result);

    expect(result.current.records.map((r) => r.id)).toEqual(['shared']);
  });

  it('stops after five pages and reports how much of NRPTI’s total it read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const q = new URL(String(input)).searchParams;
        if (q.get('and[_epicProjectId]') !== BRUCEJACK) return page([]);
        const pageNum = q.get('pageNum');
        return page(Array.from({ length: 1000 }, (_, i) => record(`p${pageNum}-${i}`)), 6000);
      }),
    );

    const result = renderNrpti(BRUCEJACK);
    await settled(result);

    expect(result.current.truncated).toEqual([{ what: 'records', read: 5000, total: 6000 }]);
  });

  // NRPTI may send no total; one row asked for past the fifth page tells "more" from "exactly five pages".
  it.each([
    ['notes rows left behind', () => page([record('after')]), [{ what: 'records', read: 5000, total: null }]],
    ['notes nothing when the fifth page was the last', () => page([]), []],
    ['keeps the rows read when the probe itself fails', () => json({ error: 'down' }, 502), [{ what: 'records', read: 5000, total: null }]],
  ])('without a total, %s', async (_name, probe, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const q = new URL(String(input)).searchParams;
        if (q.get('and[_epicProjectId]') !== BRUCEJACK) return page([]);
        if (q.get('pageSize') === '1' && q.get('pageNum') === '5000') return probe();
        const pageNum = q.get('pageNum');
        return page(Array.from({ length: 1000 }, (_, i) => record(`p${pageNum}-${i}`)));
      }),
    );

    const result = renderNrpti(BRUCEJACK);
    await waitFor(() => expect(result.current.recordsLoading).toBe(false));

    expect(result.current.isError).toBe(false);
    expect(result.current.truncated).toEqual(expected);
  });
});
