'use strict';

// documents.listSyncPending: the document rows the sync-out pending hook re-queues.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const documents = require('../../src/repositories/documents');
const consumer = require('../../src/sync-out/eagle-document');
const { evaluate } = require('../helpers/updates-store');
const { useEnv } = require('../helpers/sync-out-eagle');

const doc = (id, syncVersion, sentVersion, eagleId = `eagle-${id}`) => ({
  id, projectId: `project-${id}`, sourceSystem: 'demi', syncVersion, eagleId,
  ...(sentVersion === undefined ? {} : { syncOut: { eagle: { sentVersion } } })
});

const minted = (row, eagle) => ({ ...row, syncOut: { eagle: { mintedId: row.eagleId, ...eagle } } });

const ROWS = [
  doc('behind', 2, 1),
  doc('sent', 1, 1),
  doc('never-sent', 1),
  doc('tied-never-minted', 0),
  minted(doc('minted-unlanded', 0), { status: 'failed' }),
  minted(doc('minted-landed', 0), { status: 'sent', sentVersion: 0 }),
  { ...doc('native-new'), eagleId: undefined },
  { ...doc('native-unscanned'), eagleId: undefined, scanStatus: 'pending', displayName: 'Not sent' },
  doc('untied-raised', 1, 0, null),
  doc('untied-sent', 0, 0, null),
  { ...doc('eagle-owned', 2), sourceSystem: 'eagle' }
];

/** Answer each query from ROWS by evaluating its SQL and projecting its fields, one row per page so paging shows. */
function store(t) {
  const calls = [];
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    calls.push({ container, options });
    const [, select, where] = /^SELECT (.+?) FROM c WHERE (.+)$/s.exec(spec.query);
    const fields = select.split(', ').map(field => field.replace(/^c\./, ''));
    const params = Object.fromEntries((spec.parameters || []).map(p => [p.name, p.value]));
    const hits = ROWS.filter(row => evaluate(where, row, params))
      .map(row => Object.fromEntries(fields.filter(f => Object.hasOwn(row, f)).map(f => [f, row[f]])));
    const at = Number(options.continuationToken || 0);
    const next = at + 1 < hits.length ? String(at + 1) : undefined;
    return { items: hits.slice(at, at + 1), continuationToken: next };
  });
  return calls;
}

test('documents.listSyncPending', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('lists DEMI rows past their sent version, and never-sent ones not tied to a foreign id, every page', async () => {
    const calls = store(t);

    const rows = await documents.listSyncPending();

    assert.deepStrictEqual(rows.map(row => row.id),
      ['behind', 'never-sent', 'minted-unlanded', 'native-new', 'native-unscanned', 'untied-raised']);
    assert.deepStrictEqual(calls.map(c => c.options), [{}, ...[1, 2, 3, 4, 5].map(n => ({ continuationToken: String(n) }))]);
    assert.strictEqual(calls[0].container, 'documents');
  });

  await t.test('the listed fields are all the document consumer needs to tell which rows it wants', async (tt) => {
    useEnv(tt, { SYNC_OUT_EAGLE_NATIVE_ENABLED: 'true' });
    store(t);

    const rows = await documents.listSyncPending();

    assert.deepStrictEqual(rows.filter(consumer.wants).map(row => row.id),
      ['behind', 'never-sent', 'minted-unlanded', 'native-new', 'untied-raised'], 'not the unscanned row');
    assert.ok(rows.every(row => !Object.hasOwn(row, 'displayName')), 'only the named fields are read');
  });
});
