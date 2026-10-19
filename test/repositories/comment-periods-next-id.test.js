'use strict';

// commentPeriods.nextCommentId over a fake Cosmos patch that applies the patch condition to one
// stored row, and the DEMI upstream ACL that aclRowsForProject hands the project cascade.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const commentPeriods = require('../../src/repositories/comment-periods');
const { systemAccess } = require('../../src/helpers/access-sql');

const PERIOD = 'a1b2c3d4-0000-4000-8000-000000000001';
const PROJECT = 'p-1';

/** One stored row; `patch` honours the two conditions nextCommentId sends, as Cosmos would. */
function fakeStore(t, row) {
  const store = { row: row && { ...row }, partitions: [] };
  t.mock.method(cosmos, 'patch', async (container, id, partitionKey, operations, condition) => {
    store.partitions.push(partitionKey);
    if (!store.row || store.row.id !== id || store.row.projectId !== partitionKey) {
      throw Object.assign(new Error('missing'), { code: 404 });
    }
    const isNumber = typeof store.row.commentIdCount === 'number';
    const wantsNumber = !condition.includes('NOT IS_NUMBER');
    if (isNumber !== wantsNumber) throw Object.assign(new Error('precondition'), { code: 412 });
    for (const op of operations) {
      store.row.commentIdCount = op.op === 'incr' ? store.row.commentIdCount + op.value : op.value;
    }
    return { ...store.row };
  });
  t.mock.method(cosmos, 'readItem', async () => null);
  t.mock.method(cosmos, 'query', async () => ({ items: store.row ? [{ ...store.row }] : [] }));
  return store;
}

test('commentPeriods.nextCommentId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('answers the count after the increment, and stores it', async (t) => {
    const store = fakeStore(t, { id: PERIOD, projectId: PROJECT, commentIdCount: 4 });
    assert.strictEqual(await commentPeriods.nextCommentId(PERIOD, PROJECT), 5);
    assert.strictEqual(await commentPeriods.nextCommentId(PERIOD, PROJECT), 6);
    assert.strictEqual(store.row.commentIdCount, 6);
  });

  await t.test('a mirrored row holding null starts at 1, then counts on', async (t) => {
    fakeStore(t, { id: PERIOD, projectId: PROJECT, commentIdCount: null });
    assert.strictEqual(await commentPeriods.nextCommentId(PERIOD, PROJECT), 1);
    assert.strictEqual(await commentPeriods.nextCommentId(PERIOD, PROJECT), 2);
  });

  await t.test('without the project it finds the partition from the stored row', async (t) => {
    const store = fakeStore(t, { id: PERIOD, projectId: PROJECT, commentIdCount: 0 });
    assert.strictEqual(await commentPeriods.nextCommentId(PERIOD), 1);
    assert.deepStrictEqual(store.partitions, [PROJECT]);
  });

  await t.test('a missing period answers null', async (t) => {
    fakeStore(t, null);
    assert.strictEqual(await commentPeriods.nextCommentId(PERIOD, PROJECT), null);
    assert.strictEqual(await commentPeriods.nextCommentId(PERIOD), null);
  });
});

test('aclRowsForProject gives a DEMI row its own stored read as the upstream ACL', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.mock.method(cosmos, 'query', async () => ({
    items: [
      { id: 'd', read: ['staff'], sourceSystem: 'demi', demiRead: ['public', 'staff'], eagleRead: undefined },
      { id: 'e', read: ['staff'], sourceSystem: 'eagle', eagleRead: ['public'], demiRead: ['staff'] },
      { id: 'g', read: ['staff'], sourceSystem: 'engage', engageRead: ['public'], eagleRead: ['staff'] }
    ]
  }));

  const rows = await commentPeriods.aclRowsForProject(systemAccess(), PROJECT);

  assert.deepStrictEqual(rows.map(r => [r.id, r.eagleRead]),
    [['d', ['public', 'staff']], ['e', ['public']], ['g', ['public']]]);
});
