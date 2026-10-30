'use strict';

// documents.readForWriteByEagleId: the row the Eagle echo lands on when it is not stored under the Eagle id.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const documents = require('../../src/repositories/documents');
const { DUPLICATE_ID } = require('../../src/helpers/duplicate-id');
const { evaluate } = require('../helpers/updates-store');

const EAGLE_ID = '5cf00c03a266b7e1877504dd';

/** Answer each query from `rows` by its SQL, within the partition when one is given. */
function store(t, rows) {
  const calls = [];
  t.mock.method(cosmos, 'query', async (_container, spec, options = {}) => {
    calls.push(options.partitionKey ?? null);
    const where = /^SELECT \* FROM c WHERE (.+)$/s.exec(spec.query)[1];
    const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
    const items = rows.filter(row => (options.partitionKey === undefined || row.projectId === options.partitionKey) &&
      evaluate(where, row, params));
    return { items };
  });
  return calls;
}

test('documents.readForWriteByEagleId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('finds the row in the partition without a cross-partition read', async () => {
    const calls = store(t, [{ id: 'a', projectId: 'p1', eagleId: EAGLE_ID }, { id: 'b', projectId: 'p1', eagleId: 'other' }]);

    assert.strictEqual((await documents.readForWriteByEagleId(EAGLE_ID, 'p1')).id, 'a');
    assert.deepStrictEqual(calls, ['p1']);
  });

  await t.test('falls back across partitions, and finds nothing when no row names the id', async () => {
    const calls = store(t, [{ id: 'a', projectId: 'p2', eagleId: EAGLE_ID }]);

    assert.strictEqual((await documents.readForWriteByEagleId(EAGLE_ID, 'p1')).id, 'a');
    assert.strictEqual(await documents.readForWriteByEagleId('missing', 'p1'), null);
    assert.deepStrictEqual(calls, ['p1', null, 'p1', null]);
  });

  await t.test('two rows naming the id throw DUPLICATE_ID', async () => {
    store(t, [{ id: 'a', projectId: 'p2', eagleId: EAGLE_ID }, { id: 'b', projectId: 'p3', eagleId: EAGLE_ID }]);

    await assert.rejects(documents.readForWriteByEagleId(EAGLE_ID, 'p1'), err => err.code === DUPLICATE_ID);
  });
});
