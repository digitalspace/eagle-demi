'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const { backfillEagleLadder, parseArgs, exitCodeFor } = require('../../src/scripts/backfill-eagle-ladder');
const { evaluate } = require('../helpers/updates-store');

const PUBLIC = ['staff', 'idir', 'public'];
// A project the dropped rule widened: Eagle says `['sysadmin']`, DEMI stored it with `staff`.
const WIDENED_PROJECT = { id: 'p-w', eagleId: 'e-w', read: ['sysadmin', 'staff'], eagleRead: ['sysadmin'], _etag: 'x' };
const PUBLIC_PROJECT = { id: 'p-pub', eagleId: 'e-pub', read: PUBLIC, eagleRead: ['sysadmin', 'public'], _etag: 'x' };
const NOTIFICATION = { id: 'n-1', read: ['sysadmin', 'staff'], eagleRead: ['sysadmin'], hasEagleSource: true, _etag: 'x' };

/**
 * `cosmos.queryPage` and `cosmos.bulkVerified` replaced for the run. A query answers the rows its
 * WHERE holds for, `hasEagleSource` standing in for `sources.eagle`. A write applies its `set` ops
 * to a private copy of the row when `ifMatch` holds, and answers a 412 (`skippedIds`) when it does
 * not. `stale` hands every row out with an etag that no longer matches; `refuse` maps an id to the
 * answer its write gets instead, `'stale'` (412) or `'failed'`.
 */
function fakeCosmos(t, seed, { stale = false, refuse = {} } = {}) {
  const rows = structuredClone(seed);
  const writes = [];
  let etag = 0;
  t.mock.method(cosmos, 'queryPage', async (container, spec, { size, skip }) => {
    const where = / WHERE (.+) ORDER BY /s.exec(spec.query)[1];
    const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
    return (rows[container] || [])
      .filter(r => evaluate(where, { ...r, sources: r.hasEagleSource ? { eagle: {} } : undefined }, params))
      .slice(skip, skip + size).map(r => ({ ...r, ...(stale && { _etag: 'old' }) }));
  });
  t.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
    const skippedIds = [];
    const failedIds = [];
    for (const op of operations) {
      writes.push({ container, ...op });
      const row = rows[container].find(r => String(r.id) === op.id);
      if (refuse[op.id] === 'failed') { failedIds.push(op.id); continue; }
      const etagMoved = op.ifMatch !== undefined && row._etag !== op.ifMatch;
      if (etagMoved || refuse[op.id] === 'stale') { skippedIds.push(op.id); continue; }
      for (const set of op.resourceBody.operations) row[set.path.slice(1)] = set.value;
      row._etag = `e${++etag}`;
    }
    return {
      succeeded: operations.length - skippedIds.length - failedIds.length,
      failed: failedIds.length, skippedIds, failedIds
    };
  });
  return writes;
}

const valueOf = (writes, id, path) => {
  const op = writes.find(w => w.id === id);
  const set = op && op.resourceBody.operations.find(o => o.path === path);
  return set ? set.value : undefined;
};
const readOf = (writes, id) => valueOf(writes, id, '/read');
const summaryOf = (summaries, container) => summaries.find(s => s.container === container);
const reverse = (...flags) => backfillEagleLadder(['--reverse', ...flags]);

test('backfill-eagle-ladder --reverse', async (t) => {
  await t.test('a dry run writes nothing and counts what a live run writes', async (t) => {
    const writes = fakeCosmos(t, { projects: [WIDENED_PROJECT, PUBLIC_PROJECT] });
    const summaries = await reverse();
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(summaryOf(summaries, 'projects').planned, 1);
  });

  await t.test('a widened project goes back to Eagle\'s read', async (t) => {
    const writes = fakeCosmos(t, { projects: [WIDENED_PROJECT] });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'p-w'), ['sysadmin']);
    assert.strictEqual(valueOf(writes, 'p-w', '/isPublished'), false);
  });

  await t.test('the patch is conditioned on the row\'s etag, in its own partition', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [WIDENED_PROJECT],
      documents: [{ id: 'd-1', projectId: 'p-w', eagleId: 'd-1', read: ['staff'], ownRead: ['sysadmin'], _etag: 'd-etag' }]
    });
    await reverse('--live');
    const op = writes.find(w => w.id === 'd-1');
    assert.strictEqual(op.ifMatch, 'd-etag');
    assert.strictEqual(op.partitionKey, 'p-w');
  });

  await t.test('a notification, a list item and a user lose the added staff', async (t) => {
    const writes = fakeCosmos(t, {
      notifications: [{ ...NOTIFICATION, read: ['sysadmin', 'inspector', 'staff'], eagleRead: ['sysadmin', 'inspector'] }],
      lists: [{ id: 'o-1', kind: 'organization', eagleId: 'o-1', read: ['sysadmin', 'staff'], eagleRead: ['sysadmin'], _etag: 'x' }],
      users: [{ id: 'u-1', eagleId: 'u-1', read: ['sysadmin', 'staff'], eagleRead: ['sysadmin', ''], _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'n-1'), ['sysadmin', 'inspector']);
    assert.deepStrictEqual(readOf(writes, 'o-1'), ['sysadmin']);
    assert.deepStrictEqual(readOf(writes, 'u-1'), ['sysadmin']);
  });

  await t.test('a deleted user under the delete ceiling goes back to Eagle\'s read', async (t) => {
    const writes = fakeCosmos(t, {
      users: [{ id: 'u-1', eagleId: 'u-1', read: ['staff'], eagleRead: ['sysadmin'], eagleDeleted: true, _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'u-1'), ['sysadmin']);
  });

  await t.test('children are capped by the parent\'s reversed read, all the way down', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [WIDENED_PROJECT],
      commentPeriods: [{ id: 'cp-1', projectId: 'p-w', eagleId: 'cp-1', read: ['staff'], eagleRead: ['public'], _etag: 'x' }],
      comments: [{ id: 'c-1', periodId: 'cp-1', eagleId: 'c-1', read: ['staff'], eagleRead: ['public'], _etag: 'x' }],
      documents: [{ id: 'd-1', projectId: 'p-w', eagleId: 'd-1', read: ['staff'], ownRead: ['sysadmin', 'inspector'], _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'cp-1'), ['sysadmin']);
    assert.deepStrictEqual(readOf(writes, 'c-1'), ['sysadmin']);
    assert.deepStrictEqual(readOf(writes, 'd-1'), ['sysadmin']);
  });

  await t.test('a child whose Eagle read has no ladder token keeps it under a public parent', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [PUBLIC_PROJECT],
      groups: [{ id: 'g-1', projectId: 'p-pub', eagleId: 'g-1', read: ['staff'], eagleRead: ['sysadmin', 'inspector'], _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'g-1'), ['sysadmin', 'inspector']);
  });

  await t.test('a row the old cap stored at team under a team parent goes to the current cap', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [{ ...WIDENED_PROJECT, read: ['team'], eagleRead: ['team'] }],
      groups: [{ id: 'g-1', projectId: 'p-w', eagleId: 'g-1', read: ['team'], eagleRead: ['sysadmin', 'inspector'], _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'g-1'), ['sysadmin']);
  });

  await t.test('a parent whose patch is refused still caps its children at its stored read', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [WIDENED_PROJECT],
      documents: [{ id: 'd-1', projectId: 'p-w', eagleId: 'd-1', read: ['staff'], ownRead: ['public'], _etag: 'x' }]
    }, { refuse: { 'p-w': 'stale' } });
    await reverse('--live');
    assert.strictEqual(writes.some(w => w.id === 'd-1'), false);
  });

  await t.test('an inspection whose patch fails still caps its elements at its stored read', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [PUBLIC_PROJECT],
      inspections: [
        { id: 'el-1', kind: 'InspectionElement', inspection: 'i-1', eagleId: 'el-1', read: ['staff'], eagleRead: ['public'], _etag: 'x' },
        { id: 'i-1', kind: 'Inspection', inspection: 'i-1', projectId: 'p-pub', eagleId: 'i-1', read: ['staff'], eagleRead: ['sysadmin'], _etag: 'x' }
      ]
    }, { refuse: { 'i-1': 'failed' } });
    await reverse('--live');
    assert.strictEqual(writes.some(w => w.id === 'el-1'), false);
  });

  await t.test('a document under a notification is not capped by it', async (t) => {
    const writes = fakeCosmos(t, {
      notifications: [{ ...NOTIFICATION, read: PUBLIC, eagleRead: ['public'] }],
      documents: [{ id: 'd-1', projectId: 'n-1', eagleId: 'd-1', read: ['sysadmin', 'staff'], ownRead: ['sysadmin'], _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'd-1'), ['sysadmin']);
  });

  await t.test('inspections reverse inspection, then element, then item, whatever the scan order', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [PUBLIC_PROJECT],
      inspections: [
        { id: 'it-1', kind: 'InspectionItem', inspection: 'i-1', element: 'el-1', eagleId: 'it-1', read: ['staff'], eagleRead: ['public'], _etag: 'x' },
        { id: 'el-1', kind: 'InspectionElement', inspection: 'i-1', eagleId: 'el-1', read: ['staff'], eagleRead: ['public'], _etag: 'x' },
        { id: 'i-1', kind: 'Inspection', inspection: 'i-1', projectId: 'p-pub', eagleId: 'i-1', read: ['staff'], eagleRead: ['sysadmin'], _etag: 'x' }
      ]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'i-1'), ['sysadmin']);
    assert.deepStrictEqual(readOf(writes, 'el-1'), ['sysadmin']);
    assert.deepStrictEqual(readOf(writes, 'it-1'), ['sysadmin']);
  });

  await t.test('an inspection with no project is reversed uncapped', async (t) => {
    const writes = fakeCosmos(t, {
      inspections: [{ id: 'i-1', kind: 'Inspection', inspection: 'i-1', projectId: null, eagleId: 'i-1', read: ['sysadmin', 'staff'], eagleRead: ['sysadmin'], _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'i-1'), ['sysadmin']);
  });

  await t.test('an Update under a public parent loses the added staff', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [PUBLIC_PROJECT],
      updates: [{ id: 'up-1', projectId: 'e-pub', eagleId: 'up-1', read: ['sysadmin', 'staff'], eagleRead: ['sysadmin'], _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'up-1'), ['sysadmin']);
  });

  await t.test('an Update under a widened parent is capped by its reversed read', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [WIDENED_PROJECT],
      updates: [{ id: 'up-1', projectId: 'e-w', eagleId: 'up-1', read: ['staff'], eagleRead: ['public'], _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'up-1'), ['sysadmin']);
  });

  await t.test('a row DEMI narrowed is skipped and counted, and its children capped by it', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [{ ...WIDENED_PROJECT, read: ['team'] }],
      documents: [{ id: 'd-1', projectId: 'p-w', eagleId: 'd-1', read: ['team'], ownRead: ['public'], _etag: 'x' }]
    });
    const summaries = await reverse('--live');
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(summaryOf(summaries, 'projects').skippedDiffers, 1);
  });

  await t.test('a document with a held level is skipped and counted', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [WIDENED_PROJECT],
      documents: [{ id: 'd-1', projectId: 'p-w', eagleId: 'd-1', read: ['staff'], ownRead: ['sysadmin'], levelHeldAt: '2026-10-06T00:00:00Z', _etag: 'x' }]
    });
    const summaries = await reverse('--live');
    assert.strictEqual(readOf(writes, 'd-1'), undefined);
    assert.strictEqual(summaryOf(summaries, 'documents').skippedHeld, 1);
  });

  await t.test('a row DEMI sealed is skipped and counted', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [{ ...WIDENED_PROJECT, read: ['compliance'], sealedAt: '2026-10-06T00:00:00Z' }]
    });
    const summaries = await reverse('--live');
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(summaryOf(summaries, 'projects').skippedHeld, 1);
  });

  await t.test('a row the dropped rule never touched is not counted', async (t) => {
    fakeCosmos(t, { projects: [PUBLIC_PROJECT] });
    const summaries = await reverse();
    const s = summaryOf(summaries, 'projects');
    assert.deepStrictEqual([s.scanned, s.planned, s.skippedDiffers], [1, 0, 0]);
  });

  await t.test('a row the dropped rule never touched is not read', async (t) => {
    fakeCosmos(t, {
      projects: [PUBLIC_PROJECT],
      documents: [{ id: 'd-1', projectId: 'p-pub', eagleId: 'd-1', read: ['sysadmin'], ownRead: ['sysadmin'], _etag: 'x' }]
    });
    const summaries = await reverse();
    assert.strictEqual(summaryOf(summaries, 'documents').scanned, 0);
  });

  await t.test('a child whose parent is not stored is counted, not written', async (t) => {
    const writes = fakeCosmos(t, {
      comments: [{ id: 'c-1', periodId: 'cp-gone', eagleId: 'c-1', read: ['staff'], eagleRead: ['sysadmin'], _etag: 'x' }]
    });
    const summaries = await reverse('--live');
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(summaryOf(summaries, 'comments').noParent, 1);
  });

  // A seed stores a document whose project is not stored at its uncapped read.
  const orphanDocument = read => ({
    id: 'd-1', projectId: 'p-gone', eagleId: 'd-1', read, ownRead: ['sysadmin'], _etag: 'x'
  });

  await t.test('a document whose project is not stored loses the added staff, and is counted', async (t) => {
    const writes = fakeCosmos(t, { documents: [orphanDocument(['sysadmin', 'staff'])] });
    const summaries = await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'd-1'), ['sysadmin']);
    const s = summaryOf(summaries, 'documents');
    assert.deepStrictEqual([s.patched, s.parentMissing, s.noParent], [1, 1, 0]);
  });

  await t.test('a document whose project is not stored keeps a read the rule did not give', async (t) => {
    const writes = fakeCosmos(t, { documents: [orphanDocument(['sysadmin', 'staff', 'idir', 'public'])] });
    const summaries = await reverse('--live');
    assert.strictEqual(writes.length, 0);
    const s = summaryOf(summaries, 'documents');
    assert.deepStrictEqual([s.skippedDiffers, s.parentMissing], [1, 1]);
  });

  await t.test('a row changed since the scan is counted stale, not failed', async (t) => {
    fakeCosmos(t, { projects: [WIDENED_PROJECT] }, { stale: true });
    const summaries = await reverse('--live');
    assert.deepStrictEqual([summaryOf(summaries, 'projects').stale, summaryOf(summaries, 'projects').failed], [1, 0]);
  });

  await t.test('a second live run plans nothing', async (t) => {
    fakeCosmos(t, {
      projects: [{ ...WIDENED_PROJECT }],
      notifications: [{ ...NOTIFICATION }],
      commentPeriods: [{ id: 'cp-1', projectId: 'p-w', eagleId: 'cp-1', read: ['staff'], eagleRead: ['public'], _etag: 'x' }],
      comments: [{ id: 'c-1', periodId: 'cp-1', eagleId: 'c-1', read: ['staff'], eagleRead: ['public'], _etag: 'x' }],
      updates: [{ id: 'up-1', projectId: 'n-1', eagleId: 'up-1', read: ['sysadmin', 'staff'], eagleRead: ['sysadmin'], _etag: 'x' }]
    });
    const first = await reverse('--live');
    const second = await reverse('--live');
    assert.strictEqual(first.reduce((n, s) => n + s.patched, 0), 5);
    assert.strictEqual(second.reduce((n, s) => n + s.planned, 0), 0);
  });

  await t.test('groups the old cap stored against the parent\'s reversed read are patched in one pass', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [{ ...WIDENED_PROJECT, read: ['inspector', 'staff'], eagleRead: ['inspector'] }],
      groups: [
        { id: 'g-1', projectId: 'p-w', eagleId: 'g-1', read: ['team'], eagleRead: ['public'], _etag: 'x' },
        { id: 'g-2', projectId: 'p-w', eagleId: 'g-2', read: ['team'], eagleRead: ['sysadmin', 'inspector'], _etag: 'x' }
      ]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'g-1'), ['sysadmin']);
    assert.deepStrictEqual(readOf(writes, 'g-2'), ['sysadmin', 'inspector']);
    const second = await reverse('--live');
    assert.strictEqual(second.reduce((n, s) => n + s.planned, 0), 0);
  });

  await t.test('a row under a team parent the rule left alone is not rewritten', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [{ ...WIDENED_PROJECT, read: ['team'], eagleRead: ['team'] }],
      documents: [{ id: 'd-1', projectId: 'p-w', eagleId: 'd-1', read: ['team'], ownRead: ['sysadmin'], _etag: 'x' }]
    });
    await reverse('--live');
    assert.strictEqual(writes.length, 0);
  });

  await t.test('an Update the old cap kept at its own roles under a team parent goes to the current cap', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [{ ...WIDENED_PROJECT, read: ['team'], eagleRead: ['team'] }],
      updates: [{ id: 'up-1', projectId: 'e-w', eagleId: 'up-1', read: ['sysadmin', 'inspector'], eagleRead: ['sysadmin', 'inspector'], _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'up-1'), ['sysadmin']);
  });

  await t.test('a legacy open Update follows its parent\'s reversed read', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [WIDENED_PROJECT],
      updates: [{ id: 'up-1', projectId: 'e-w', eagleId: 'up-1', read: ['sysadmin', 'staff'], eagleRead: null, eagleActive: true, hasEagleSource: true, _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'up-1'), ['sysadmin']);
  });

  await t.test('a group under a notification is capped by its reversed read', async (t) => {
    const writes = fakeCosmos(t, {
      notifications: [NOTIFICATION],
      groups: [{ id: 'g-1', projectId: 'n-1', eagleId: 'g-1', read: ['staff'], eagleRead: ['public'], _etag: 'x' }]
    });
    await reverse('--live');
    assert.deepStrictEqual(readOf(writes, 'g-1'), ['sysadmin']);
  });

  await t.test('every page of a container is read', async (t) => {
    const many = Array.from({ length: 501 }, (_, i) => ({ ...WIDENED_PROJECT, id: `p-${i}`, eagleId: `e-${i}` }));
    fakeCosmos(t, { projects: many });
    const summaries = await reverse();
    assert.strictEqual(summaryOf(summaries, 'projects').planned, 501);
  });
});

test('backfill-eagle-ladder forward', async (t) => {
  await t.test('a document with no ownRead gains its stored read, and nothing adds staff', async (t) => {
    const writes = fakeCosmos(t, {
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-w', read: ['sysadmin'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(valueOf(writes, 'd-1', '/ownRead'), ['sysadmin']);
    assert.strictEqual(readOf(writes, 'd-1'), undefined);
  });

  await t.test('a document that has ownRead is left alone', async (t) => {
    const writes = fakeCosmos(t, {
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-w', read: ['sysadmin'], ownRead: ['sysadmin'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.strictEqual(writes.length, 0);
  });

  await t.test('a dry run writes nothing', async (t) => {
    const writes = fakeCosmos(t, { documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-w', read: ['sysadmin'] }] });
    const summaries = await backfillEagleLadder([]);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(summaries[0].planned, 1);
  });
});

test('arguments and exit code', async (t) => {
  await t.test('an unknown argument is refused', () => {
    assert.throws(() => parseArgs(['--force']), /unknown argument/);
  });

  await t.test('--reverse selects the reverse pass', () => {
    assert.strictEqual(parseArgs(['--reverse', '--live']).reverse, true);
  });

  await t.test('a failed write exits 1', () => {
    assert.strictEqual(exitCodeFor([{ failed: 1 }]), 1);
  });

  await t.test('a run with no failed write exits 0', () => {
    assert.strictEqual(exitCodeFor([{ failed: 0 }]), 0);
  });
});
