'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseArgs, backfillEagleStaffFields, exitCodeFor
} = require('../../src/scripts/backfill-eagle-staff-fields');
const { evaluate } = require('../helpers/updates-store');
const {
  eagleComment, eaglePeriod, eagleOrganization, PERIOD_EAGLE_ID, COMMENT_EAGLE_ID, ORG_EAGLE_ID,
  PUBLIC_ACL, STAFF_COMMENT_FIELDS, STAFF_PERIOD_FIELDS, STAFF_ORGANIZATION_FIELDS
} = require('../helpers/eagle-mirror-fixtures');

const OTHER_PERIOD = '5b8bcf0d0f5e9c0019a7a1d1';

/** Rows as the mirrors stored them before the staff fields were promoted. */
function seedRows() {
  return {
    comments: [
      { id: COMMENT_EAGLE_ID, periodId: PERIOD_EAGLE_ID, projectId: '207', sourceSystem: 'eagle',
        comment: 'The turbine setback is too small.', read: PUBLIC_ACL, _etag: 'e1',
        sources: { eagle: eagleComment() } },
      { id: 'c2', periodId: OTHER_PERIOD, projectId: '207', sourceSystem: 'eagle', read: PUBLIC_ACL,
        _etag: 'e2', sources: { eagle: eagleComment({ _id: 'c2', eaoNotes: 'Second period.' }) } },
      // Sealed: the ladder read never returns it, so it is neither scanned nor counted.
      { id: 'c3', periodId: PERIOD_EAGLE_ID, projectId: '207', sourceSystem: 'eagle',
        read: ['compliance'], _etag: 'e3', sources: { eagle: eagleComment({ _id: 'c3' }) } },
      // A row whose push never kept the raw record: nothing to copy from.
      { id: 'c4', periodId: PERIOD_EAGLE_ID, projectId: '207', sourceSystem: 'eagle',
        read: PUBLIC_ACL, _etag: 'e4' }
    ],
    commentPeriods: [
      { id: PERIOD_EAGLE_ID, projectId: '207', sourceSystem: 'eagle', read: PUBLIC_ACL,
        _etag: 'p1', sources: { eagle: eaglePeriod() } },
      // Already current: a re-run must not pay to rewrite it.
      { id: 'p2', projectId: '207', sourceSystem: 'eagle', read: PUBLIC_ACL, _etag: 'p2',
        ...STAFF_PERIOD_FIELDS, sources: { eagle: eaglePeriod({ _id: 'p2' }) } }
    ],
    lists: [
      { id: ORG_EAGLE_ID, kind: 'Organization', sourceSystem: 'eagle', name: 'Nicomen Energy Ltd',
        read: PUBLIC_ACL, _etag: 'o1', sources: { eagle: eagleOrganization() } },
      // A List row shares the container; its raw record must never be read as an organization.
      { id: 'l1', kind: 'List', sourceSystem: 'eagle', name: 'Proponent', read: PUBLIC_ACL,
        _etag: 'l1', sources: { eagle: { _id: 'l1', name: 'Proponent', description: 'a label' } } }
    ]
  };
}

const PARTITION = { comments: 'periodId', commentPeriods: 'projectId', lists: 'kind' };

/**
 * A Cosmos double that evaluates the WHERE clause the script sends and applies Replace operations
 * under their etag, answering 412 when the row moved, as the service does.
 */
function fakeCosmos(rows, { failWrites = false, moveEtag = null, shortCount = 0 } = {}) {
  const calls = [];
  const matching = (container, spec) => {
    const where = /WHERE (.+)$/s.exec(spec.query)[1];
    const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
    return rows[container].filter(row => evaluate(where, row, params));
  };
  return {
    rows,
    calls,
    fetchAll: async (container, spec) => matching(container, spec).map(r => structuredClone(r)),
    count: async (container, spec) => matching(container, spec).length + shortCount,
    bulkVerified: async (container, operations) => {
      calls.push({ container, operations });
      let succeeded = 0;
      const skippedIds = [];
      for (const op of operations) {
        const i = rows[container].findIndex(r => r.id === op.id
          && r[PARTITION[container]] === op.partitionKey);
        if (op.id === moveEtag || rows[container][i]._etag !== op.ifMatch) {
          skippedIds.push(op.id);
          continue;
        }
        if (failWrites) continue;
        rows[container][i] = { ...op.resourceBody, _etag: `${op.ifMatch}+` };
        succeeded++;
      }
      return { succeeded, failed: operations.length - succeeded - skippedIds.length, skippedIds };
    }
  };
}

const byContainer = (summaries) => Object.fromEntries(summaries.map(s => [s.container, s]));
const pick = (row, fields) => Object.fromEntries(Object.keys(fields).map(k => [k, row[k]]));

test('backfill-eagle-staff-fields arguments', async (t) => {
  await t.test('dry run by default, --live is the mutating flag', () => {
    assert.strictEqual(parseArgs([]).live, false);
    assert.strictEqual(parseArgs(['--dry-run']).live, false);
    assert.strictEqual(parseArgs(['--live']).live, true);
  });

  await t.test('an unknown argument is refused, never ignored', () => {
    assert.throws(() => parseArgs(['--all']), /unknown argument/);
  });
});

test('a dry run counts per container and writes nothing', async () => {
  const db = fakeCosmos(seedRows());
  const before = structuredClone(db.rows);

  const s = byContainer(await backfillEagleStaffFields([], db));

  assert.deepStrictEqual(
    [s.comments.planned, s.comments.noSource, s.comments.scanned, s.comments.expected],
    [2, 1, 3, 3]);
  assert.deepStrictEqual([s.commentPeriods.planned, s.commentPeriods.current], [1, 1]);
  assert.deepStrictEqual([s.lists.scanned, s.lists.planned], [1, 1], 'the List row is not read');
  assert.strictEqual(db.calls.length, 0);
  assert.deepStrictEqual(db.rows, before);
});

test('a live run copies the staff fields from sources.eagle', async (t) => {
  const db = fakeCosmos(seedRows());
  const summaries = await backfillEagleStaffFields(['--live'], db);
  const s = byContainer(summaries);

  await t.test('every planned row is written and the run exits 0', () => {
    assert.deepStrictEqual(
      [s.comments.written, s.commentPeriods.written, s.lists.written], [2, 1, 1]);
    assert.strictEqual(exitCodeFor(summaries), 0);
  });

  await t.test('a comment gains its review fields and keeps the rest of the row', () => {
    const row = db.rows.comments[0];
    assert.deepStrictEqual(pick(row, STAFF_COMMENT_FIELDS), { ...STAFF_COMMENT_FIELDS });
    assert.strictEqual(row.comment, 'The turbine setback is too small.');
    assert.deepStrictEqual(row.sources, { eagle: eagleComment() });
  });

  await t.test('a period and an organization gain theirs', () => {
    assert.deepStrictEqual(pick(db.rows.commentPeriods[0], STAFF_PERIOD_FIELDS),
      { ...STAFF_PERIOD_FIELDS });
    assert.deepStrictEqual(pick(db.rows.lists[0], STAFF_ORGANIZATION_FIELDS),
      { ...STAFF_ORGANIZATION_FIELDS });
  });

  await t.test('the List row, the sealed row and the source-less row are untouched', () => {
    const fresh = seedRows();
    assert.deepStrictEqual(db.rows.lists[1], fresh.lists[1]);
    assert.deepStrictEqual(db.rows.comments[2], fresh.comments[2]);
    assert.deepStrictEqual(db.rows.comments[3], fresh.comments[3]);
  });

  await t.test('each bulk request stays in one partition, guarded by the etag read', () => {
    const comments = db.calls.filter(c => c.container === 'comments');
    assert.deepStrictEqual(comments.map(c => c.operations.map(o => o.partitionKey)),
      [[PERIOD_EAGLE_ID], [OTHER_PERIOD]]);
    assert.deepStrictEqual(comments[0].operations[0].ifMatch, 'e1');
    assert.ok(!('_etag' in comments[0].operations[0].resourceBody));
  });

  await t.test('a second run plans nothing', async () => {
    const again = byContainer(await backfillEagleStaffFields([], db));
    assert.deepStrictEqual(
      [again.comments.planned, again.commentPeriods.planned, again.lists.planned], [0, 0, 0]);
  });
});

test('a row a push rewrote meanwhile is left to the push, and is not a failure', async () => {
  const db = fakeCosmos(seedRows(), { moveEtag: COMMENT_EAGLE_ID });

  const summaries = await backfillEagleStaffFields(['--live'], db);

  assert.deepStrictEqual([byContainer(summaries).comments.raced, db.rows.comments[0].eaoNotes],
    [1, undefined]);
  assert.strictEqual(exitCodeFor(summaries), 0);
});

test('a rejected write exits 1', async () => {
  const summaries = await backfillEagleStaffFields(['--live'], fakeCosmos(seedRows(), { failWrites: true }));

  assert.strictEqual(byContainer(summaries).comments.failed, 2);
  assert.strictEqual(exitCodeFor(summaries), 1);
});

test('a read that returned fewer rows than the count exits 1', async () => {
  const summaries = await backfillEagleStaffFields([], fakeCosmos(seedRows(), { shortCount: 1 }));

  assert.strictEqual(exitCodeFor(summaries), 1);
});
