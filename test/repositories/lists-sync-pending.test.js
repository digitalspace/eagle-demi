'use strict';

// lists.listSyncPending: the rows of one kind the sync-out pending hook re-queues.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const lists = require('../../src/repositories/lists');
const { evaluate } = require('../helpers/updates-store');

const org = (id, syncVersion, sentVersion) => ({
  id, kind: 'Organization', syncVersion,
  ...(sentVersion === undefined ? {} : { syncOut: { eagle: { sentVersion } } })
});

const ROWS = [
  org('behind', 2, 1),
  org('sent', 2, 2),
  org('never-sent', 1),
  org('never-changed', 0),
  { ...org('a-list', 2, 1), kind: 'List' }
];

/** Answer each query from ROWS by evaluating its SQL, one row per page so paging shows. */
function store(t) {
  const calls = [];
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    calls.push({ container, options });
    const where = /^SELECT \* FROM c WHERE (.+)$/s.exec(spec.query)[1];
    const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
    const hits = ROWS.filter(row => evaluate(where, row, params));
    const at = Number(options.continuationToken || 0);
    const next = at + 1 < hits.length ? String(at + 1) : undefined;
    return { items: hits.slice(at, at + 1), continuationToken: next };
  });
  return calls;
}

test('lists.listSyncPending', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('lists the rows of one kind past their sent version, every page', async () => {
    const calls = store(t);

    const rows = await lists.listSyncPending(lists.KINDS.ORGANIZATION);

    assert.deepStrictEqual(rows.map(row => row.id), ['behind', 'never-sent']);
    assert.deepStrictEqual(calls.map(c => c.options),
      [{ partitionKey: 'Organization' }, { partitionKey: 'Organization', continuationToken: '1' }]);
    assert.strictEqual(calls[0].container, 'lists');
  });
});
