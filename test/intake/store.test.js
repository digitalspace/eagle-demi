'use strict';

/** The intake store against a stubbed Cosmos client: settle only lands on a pending row. */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const store = require('../../src/intake/store');

const ROW = { id: 'doc-1', projectId: 'proj-1' };

test('settle patches the row in its partition, guarded on scanStatus pending', async (t) => {
  let call;
  t.mock.method(cosmos, 'patch', async (...args) => { call = args; return {}; });

  const settled = await store.settle(ROW, { scanStatus: 'clean' });

  assert.strictEqual(settled, true);
  const [container, id, partition, ops, condition] = call;
  assert.deepStrictEqual([container, id, partition], ['documents', 'doc-1', 'proj-1']);
  assert.deepStrictEqual(ops.find(o => o.path === '/scanStatus'), { op: 'set', path: '/scanStatus', value: 'clean' });
  assert.match(condition, /c\.scanStatus = 'pending'/);
});

test('settle reports false when the row is no longer pending (412)', async (t) => {
  t.mock.method(cosmos, 'patch', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });

  assert.strictEqual(await store.settle(ROW, { scanStatus: 'clean' }), false);
});

test('settle rethrows any other Cosmos failure', async (t) => {
  t.mock.method(cosmos, 'patch', async () => { throw Object.assign(new Error('throttled'), { code: 429 }); });

  await assert.rejects(store.settle(ROW, { scanStatus: 'clean' }), /throttled/);
});

test('listStalePending asks for pending rows created before the cutoff', async (t) => {
  let spec;
  t.mock.method(cosmos, 'query', async (_container, s) => { spec = s; return { items: [ROW] }; });

  const rows = await store.listStalePending('2026-10-14T12:00:00.000Z');

  assert.deepStrictEqual(rows, [ROW]);
  const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
  assert.deepStrictEqual(params, { '@pending': 'pending', '@cutoff': '2026-10-14T12:00:00.000Z' });
  assert.match(spec.query, /c\.scanStatus = @pending AND c\.createdAt < @cutoff/);
});
