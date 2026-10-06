'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const { backfillEagleLadder, parseArgs, exitCodeFor } = require('../../src/scripts/backfill-eagle-ladder');
const { eagleReadUnder } = require('../../src/seed/transform');
const documentsRepo = require('../../src/repositories/documents');
const { systemAccess } = require('../../src/helpers/access-sql');

const EAGLE_PUBLIC = ['sysadmin', 'staff', 'public'];
const STAFF_PROJECT = { id: 'p-staff', eagleId: 'e-staff', read: ['sysadmin', 'staff'], eagleRead: ['sysadmin', 'staff'] };
const ADMIN_PROJECT = { id: 'p-admin', eagleId: 'e-admin', read: ['sysadmin'], eagleRead: ['sysadmin'] };
// What `PUT /projects/:id/level` leaves on a project Eagle publishes: `readForLevel(level)`.
const TEAM_PROJECT = { id: 'p-team', eagleId: 'e-team', read: ['team'], eagleRead: EAGLE_PUBLIC };
const TAKEN_DOWN_PROJECT = { id: 'p-down', eagleId: 'e-down', read: ['staff'], eagleRead: EAGLE_PUBLIC };
// Level 1 because Eagle itself says `team`, not because DEMI narrowed it.
const EAGLE_TEAM_PROJECT = { id: 'p-eteam', eagleId: 'e-eteam', read: ['team'], eagleRead: ['team'] };
const NOTIFICATION = { id: 'n-1', read: ['sysadmin'], hasEagleSource: true };

/**
 * `cosmos.queryPage` and `cosmos.bulkVerified` replaced for the run. Each container serves its rows
 * by `skip`/`size`, as the real one pages; writes are recorded per container and succeed.
 */
function fakeCosmos(t, rows) {
  const writes = [];
  t.mock.method(cosmos, 'queryPage', async (container, _spec, { size, skip }) =>
    (rows[container] || []).slice(skip, skip + size));
  t.mock.method(cosmos, 'bulkVerified', async (container, operations) => {
    writes.push(...operations.map(op => ({ container, ...op })));
    return { succeeded: operations.length, failed: 0, skippedIds: [] };
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

test('backfill-eagle-ladder', async (t) => {
  await t.test('a dry run writes nothing', async (t) => {
    const writes = fakeCosmos(t, { projects: [ADMIN_PROJECT] });
    await backfillEagleLadder([]);
    assert.strictEqual(writes.length, 0);
  });

  await t.test('a dry run counts what a live run would change, per container', async (t) => {
    fakeCosmos(t, { projects: [ADMIN_PROJECT, STAFF_PROJECT] });
    const summaries = await backfillEagleLadder(['--dry-run']);
    assert.strictEqual(summaryOf(summaries, 'projects').planned, 1);
  });

  await t.test('a sysadmin-only project gains staff', async (t) => {
    const writes = fakeCosmos(t, { projects: [ADMIN_PROJECT] });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(readOf(writes, 'p-admin'), ['sysadmin', 'staff']);
  });

  await t.test('an inspection-style read gains staff', async (t) => {
    const writes = fakeCosmos(t, { notifications: [{ ...NOTIFICATION, read: ['sysadmin', 'inspector'] }] });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(readOf(writes, 'n-1'), ['sysadmin', 'inspector', 'staff']);
  });

  await t.test('rows that already reach staff or public are unchanged', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [STAFF_PROJECT, { id: 'p-pub', eagleId: 'e-pub', read: ['sysadmin', 'public'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.strictEqual(writes.length, 0);
  });

  await t.test('a sealed row is unchanged', async (t) => {
    const writes = fakeCosmos(t, { projects: [{ ...ADMIN_PROJECT, read: ['compliance'], sealedAt: 'x' }] });
    await backfillEagleLadder(['--live']);
    assert.strictEqual(writes.length, 0);
  });

  await t.test('a row DEMI narrowed to team is unchanged', async (t) => {
    const writes = fakeCosmos(t, { projects: [TEAM_PROJECT] });
    await backfillEagleLadder(['--live']);
    assert.strictEqual(writes.length, 0);
  });

  await t.test('a row not mirrored from Eagle is unchanged', async (t) => {
    const writes = fakeCosmos(t, { projects: [{ id: 'p-track', read: ['sysadmin'] }] });
    await backfillEagleLadder(['--live']);
    assert.strictEqual(writes.length, 0);
  });

  await t.test('a document under a staff project lands at staff', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [STAFF_PROJECT],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-staff', read: ['sysadmin'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(readOf(writes, 'd-1'), ['staff']);
  });

  await t.test('a document under a sealed project is not written', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [{ id: 'p-sealed', eagleId: 'e-sealed', read: ['compliance'], sealedAt: 'x' }],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-sealed', read: ['sysadmin'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.strictEqual(readOf(writes, 'd-1'), undefined);
  });

  await t.test('a document under a project narrowed to level 1 is not written', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [TEAM_PROJECT],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-team', read: ['sysadmin'], ownRead: ['sysadmin'] }]
    });
    const summaries = await backfillEagleLadder(['--live']);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(summaryOf(summaries, 'documents').heldByParent, 1);
  });

  await t.test('an Update under a project narrowed to level 1 is not written', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [TEAM_PROJECT],
      updates: [{ id: 'u-1', projectId: 'e-team', read: ['sysadmin'], hasEagleSource: true }]
    });
    await backfillEagleLadder(['--live']);
    assert.strictEqual(writes.length, 0);
  });

  // The push caps by the parent's stored read, a DEMI takedown included, so the backfill does too.
  await t.test('a document under a project taken down to level 2 lands at staff, as its push would', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [TAKEN_DOWN_PROJECT],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-down', read: ['sysadmin'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(readOf(writes, 'd-1'), ['staff']);
  });

  await t.test('a document under a project at its Eagle level but a different set lands at staff', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [{ id: 'p-same', eagleId: 'e-same', read: ['staff'], eagleRead: ['sysadmin', 'staff'] }],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-same', read: ['sysadmin'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(readOf(writes, 'd-1'), ['staff']);
  });

  await t.test('an Update under a project taken down to level 2 keeps its own read, widened', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [TAKEN_DOWN_PROJECT],
      updates: [{ id: 'u-1', projectId: 'e-down', read: ['sysadmin'], hasEagleSource: true }]
    });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(readOf(writes, 'u-1'), ['sysadmin', 'staff']);
  });

  await t.test('a comment under a staff period of a taken-down project lands at staff', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [TAKEN_DOWN_PROJECT],
      commentPeriods: [{ id: 'cp-1', projectId: 'p-down', read: ['staff'], hasEagleSource: true }],
      comments: [{ id: 'c-1', periodId: 'cp-1', projectId: 'p-down', read: ['sysadmin'], hasEagleSource: true }]
    });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(readOf(writes, 'c-1'), ['staff']);
  });

  for (const parent of [['team'], ['sysadmin'], [], ['project-team'], ['staff'], ['staff', 'idir', 'public']]) {
    await t.test(`a document under ${JSON.stringify(parent)} is written exactly when a push after the run gives it staff`, async (t) => {
      const writes = fakeCosmos(t, {
        projects: [{ id: 'p-x', eagleId: 'e-x', read: parent, eagleRead: EAGLE_PUBLIC }],
        documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-x', read: ['sysadmin'] }]
      });
      await backfillEagleLadder(['--live']);
      const pushed = eagleReadUnder(['sysadmin'], readOf(writes, 'p-x') || parent);
      assert.deepStrictEqual(readOf(writes, 'd-1'), pushed.includes('staff') ? pushed : undefined);
    });
  }

  await t.test('a document under a project DEMI widened above its Eagle read lands at staff', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [{ id: 'p-up', eagleId: 'e-up', read: ['staff', 'idir', 'public'], eagleRead: ['sysadmin', 'staff'] }],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-up', read: ['sysadmin'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(readOf(writes, 'd-1'), ['staff']);
  });

  await t.test('a document capped below level 2 by its parent is not widened to team', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [EAGLE_TEAM_PROJECT],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-eteam', read: ['sysadmin'] }]
    });
    const summaries = await backfillEagleLadder(['--live']);
    assert.strictEqual(readOf(writes, 'd-1'), undefined);
    assert.strictEqual(summaryOf(summaries, 'documents').heldByParent, 1);
  });

  await t.test('a child is capped by the read its parent is planned to, in the same run', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [ADMIN_PROJECT],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-admin', read: ['sysadmin'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(readOf(writes, 'd-1'), ['staff']);
  });

  await t.test('a comment is capped by its period', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [EAGLE_TEAM_PROJECT],
      commentPeriods: [{ id: 'cp-1', projectId: 'p-eteam', read: ['team'], hasEagleSource: true }],
      comments: [{ id: 'c-1', periodId: 'cp-1', projectId: 'p-team', read: ['sysadmin'], hasEagleSource: true }]
    });
    await backfillEagleLadder(['--live']);
    assert.strictEqual(readOf(writes, 'c-1'), undefined);
  });

  await t.test('a row whose parent is not in DEMI is counted and not written', async (t) => {
    const writes = fakeCosmos(t, {
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-gone', read: ['sysadmin'], ownRead: ['sysadmin'] }]
    });
    const summaries = await backfillEagleLadder(['--live']);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(summaryOf(summaries, 'documents').noParent, 1);
  });

  await t.test('a document under a notification keeps its own read, widened', async (t) => {
    const writes = fakeCosmos(t, {
      notifications: [{ ...NOTIFICATION, read: ['sysadmin', 'public'] }],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'n-1', read: ['sysadmin', 'inspector'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(readOf(writes, 'd-1'), ['sysadmin', 'inspector', 'staff']);
  });

  await t.test('an Update under a staff project keeps its own read, widened', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [STAFF_PROJECT],
      updates: [{ id: 'u-1', projectId: 'e-staff', read: ['sysadmin'], hasEagleSource: true }]
    });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(readOf(writes, 'u-1'), ['sysadmin', 'staff']);
  });

  await t.test("a document's ownRead is left without staff: the cascade adds it", async (t) => {
    const writes = fakeCosmos(t, {
      projects: [{ id: 'p-up', eagleId: 'e-up', read: ['staff'], eagleRead: [] }],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-up', read: ['sysadmin'], ownRead: ['sysadmin', 'inspector'] }]
    });
    await backfillEagleLadder(['--live']);
    const ops = writes.find(w => w.id === 'd-1').resourceBody.operations;
    assert.deepStrictEqual(readOf(writes, 'd-1'), ['staff']);
    assert.strictEqual(ops.find(o => o.path === '/ownRead'), undefined);
  });

  await t.test("a document DEMI narrowed keeps its ownRead", async (t) => {
    const writes = fakeCosmos(t, {
      projects: [STAFF_PROJECT],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-staff', read: ['team'], ownRead: ['sysadmin'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.strictEqual(writes.length, 0);
  });

  await t.test('a document with no ownRead gains its pre-run read, and a later team narrow keeps it privileged-only', async (t) => {
    const doc = { id: 'd-1', eagleId: 'd-1', projectId: 'p-staff', read: ['sysadmin'], sourceSystem: 'eagle' };
    const writes = fakeCosmos(t, { projects: [STAFF_PROJECT], documents: [doc] });
    await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(valueOf(writes, 'd-1', '/ownRead'), ['sysadmin']);
    assert.deepStrictEqual(readOf(writes, 'd-1'), ['staff'], 'in the same patch that promotes read');
    assert.match(writes[0].resourceBody.condition, /ownRead/);

    t.mock.restoreAll();
    const stored = { ...doc, read: ['staff'], ownRead: valueOf(writes, 'd-1', '/ownRead') };
    t.mock.method(cosmos, 'query', async () => ({ items: [stored], continuationToken: undefined }));
    let cascaded;
    t.mock.method(cosmos, 'bulkVerified', async (_container, operations) => {
      cascaded = operations[0].resourceBody.operations.find(o => o.path === '/read').value;
      return { succeeded: operations.length, failed: 0, statusCounts: {}, requestCharge: 1 };
    });
    await documentsRepo.setAclForProject(systemAccess(), 'p-staff', ['team']);
    assert.deepStrictEqual(cascaded, ['sysadmin']);
  });

  await t.test('a document with a ladder read and no ownRead gains ownRead only', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [STAFF_PROJECT],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-staff', read: ['public', 'sysadmin'] }]
    });
    const summaries = await backfillEagleLadder(['--live']);
    assert.deepStrictEqual(valueOf(writes, 'd-1', '/ownRead'), ['public', 'sysadmin']);
    assert.strictEqual(readOf(writes, 'd-1'), undefined);
    assert.doesNotMatch(writes[0].resourceBody.condition, /'staff'/, 'not guarded on a ladder token it has');
    assert.strictEqual(summaryOf(summaries, 'documents').ownRead, 1);
  });

  await t.test('a document holding staff with no ownRead is counted and not written', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [STAFF_PROJECT],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-staff', read: ['staff'] }]
    });
    const summaries = await backfillEagleLadder(['--live']);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(summaryOf(summaries, 'documents').staffNoOwnRead, 1);
    assert.strictEqual(summaryOf(summaries, 'documents').ownRead, 0);
  });

  await t.test('a dry run counts the ownRead writes and writes nothing', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [STAFF_PROJECT],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-staff', read: ['sysadmin'] }]
    });
    const summaries = await backfillEagleLadder([]);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(summaryOf(summaries, 'documents').ownRead, 1);
  });

  await t.test('each patch is guarded on the row still having no ladder token', async (t) => {
    const writes = fakeCosmos(t, { projects: [ADMIN_PROJECT] });
    await backfillEagleLadder(['--live']);
    assert.match(writes[0].resourceBody.condition, /'staff'/);
  });

  await t.test('the patch goes to the row\'s own partition', async (t) => {
    const writes = fakeCosmos(t, {
      projects: [STAFF_PROJECT],
      documents: [{ id: 'd-1', eagleId: 'd-1', projectId: 'p-staff', read: ['sysadmin'] }]
    });
    await backfillEagleLadder(['--live']);
    assert.strictEqual(writes.find(w => w.id === 'd-1').partitionKey, 'p-staff');
  });

  await t.test('every page of a container is read', async (t) => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `p-${i}`, eagleId: `e-${i}`, read: ['sysadmin'] }));
    fakeCosmos(t, { projects: many });
    const summaries = await backfillEagleLadder([]);
    assert.strictEqual(summaryOf(summaries, 'projects').planned, 501);
  });
});

test('arguments and exit code', async (t) => {
  await t.test('an unknown argument is refused', () => {
    assert.throws(() => parseArgs(['--force']), /unknown argument/);
  });

  await t.test('a failed write exits 1', () => {
    assert.strictEqual(exitCodeFor([{ failed: 1 }]), 1);
  });

  await t.test('a run with no failed write exits 0', () => {
    assert.strictEqual(exitCodeFor([{ failed: 0 }]), 0);
  });
});
