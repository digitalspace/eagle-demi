'use strict';

// lists.listSyncPending: the rows of one kind the sync-out pending hook re-queues.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const lists = require('../../src/repositories/lists');

test('lists.listSyncPending', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('asks one kind partition for rows past their sent version, every page', async () => {
    const calls = [];
    const pages = [
      { items: [{ id: 'a', syncVersion: 2, syncOut: { eagle: { sentVersion: 1 } } }], continuationToken: 'next' },
      { items: [{ id: 'b', syncVersion: 1 }], continuationToken: undefined }
    ];
    t.mock.method(cosmos, 'query', async (container, spec, options) => {
      calls.push({ container, spec, options });
      return pages[calls.length - 1];
    });

    const rows = await lists.listSyncPending(lists.KINDS.ORGANIZATION);

    assert.deepStrictEqual(rows.map(row => row.id), ['a', 'b']);
    assert.deepStrictEqual(calls.map(c => c.options),
      [{ partitionKey: 'Organization' }, { partitionKey: 'Organization', continuationToken: 'next' }]);
    assert.strictEqual(calls[0].container, 'lists');
    assert.strictEqual(calls[0].spec.query,
      'SELECT * FROM c WHERE c.kind = @kind AND c.syncVersion > 0 AND ' +
      '(NOT IS_NUMBER(c.syncOut.eagle.sentVersion) OR c.syncVersion > c.syncOut.eagle.sentVersion)');
    assert.deepStrictEqual(calls[0].spec.parameters, [{ name: '@kind', value: 'Organization' }]);
  });
});
