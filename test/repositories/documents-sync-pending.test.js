'use strict';

// documents.listSyncPending: the document rows the sync-out pending hook re-queues.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const documents = require('../../src/repositories/documents');
const { evaluate } = require('../helpers/updates-store');

const doc = (id, syncVersion, sentVersion) => ({
  id, projectId: `project-${id}`, syncVersion,
  ...(sentVersion === undefined ? {} : { syncOut: { eagle: { sentVersion } } })
});

const ROWS = [
  doc('behind', 2, 1),
  doc('sent', 1, 1),
  doc('never-sent', 1),
  doc('never-changed', 0)
];

/** Answer each query from ROWS by evaluating its SQL, one row per page so paging shows. */
function store(t) {
  const calls = [];
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    calls.push({ container, options });
    const where = /^SELECT \* FROM c WHERE (.+)$/s.exec(spec.query)[1];
    const params = Object.fromEntries((spec.parameters || []).map(p => [p.name, p.value]));
    const hits = ROWS.filter(row => evaluate(where, row, params));
    const at = Number(options.continuationToken || 0);
    const next = at + 1 < hits.length ? String(at + 1) : undefined;
    return { items: hits.slice(at, at + 1), continuationToken: next };
  });
  return calls;
}

test('documents.listSyncPending', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('lists rows past their sent version across partitions, every page', async () => {
    const calls = store(t);

    const rows = await documents.listSyncPending();

    assert.deepStrictEqual(rows.map(row => row.id), ['behind', 'never-sent']);
    assert.deepStrictEqual(calls.map(c => c.options), [{}, { continuationToken: '1' }]);
    assert.strictEqual(calls[0].container, 'documents');
  });
});
