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

test('scannedBytesBetween sums numeric sizes of rows scanned in the window', async (t) => {
  let spec;
  t.mock.method(cosmos, 'queryValue', async (_container, s) => { spec = s; return 1234; });

  const total = await store.scannedBytesBetween('2026-10-01', '2026-11-01');

  assert.strictEqual(total, 1234);
  const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
  assert.deepStrictEqual(params, { '@from': '2026-10-01', '@to': '2026-11-01' });
  assert.match(spec.query, /SUM\(c\.scanSizeBytes\)/);
  assert.match(spec.query, /c\.scannedAt >= @from AND c\.scannedAt < @to AND IS_NUMBER\(c\.scanSizeBytes\)/);
});

test('scannedBytesBetween reads an empty month as 0', async (t) => {
  t.mock.method(cosmos, 'queryValue', async () => null);

  assert.strictEqual(await store.scannedBytesBetween('2026-10-01', '2026-11-01'), 0);
});

test('listPending asks for one page of pending rows, oldest first, with the fields a release reads', async (t) => {
  let call;
  t.mock.method(cosmos, 'query', async (...args) => { call = args; return { items: [ROW], continuationToken: 'next' }; });

  const page = await store.listPending({ pageSize: 100, continuationToken: 'this' });

  assert.deepStrictEqual(page, { items: [ROW], continuationToken: 'next' });
  const [container, spec, options] = call;
  assert.strictEqual(container, 'documents');
  assert.deepStrictEqual(options, { maxItemCount: 100, continuationToken: 'this' });
  assert.deepStrictEqual(spec.parameters, [{ name: '@pending', value: 'pending' }]);
  assert.match(spec.query, /^SELECT c\.id, c\.projectId, c\.createdAt, c\.requestedRead, c\.s3Key, c\.fileExt FROM c /);
  assert.match(spec.query, /WHERE c\.scanStatus = @pending ORDER BY c\.createdAt ASC$/);
});

test('countPendingAfter counts pending rows created after the given time', async (t) => {
  let spec;
  t.mock.method(cosmos, 'queryValue', async (_container, s) => { spec = s; return 150; });

  assert.strictEqual(await store.countPendingAfter('2026-10-14T12:00:00.000Z'), 150);
  const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
  assert.deepStrictEqual(params, { '@pending': 'pending', '@after': '2026-10-14T12:00:00.000Z' });
  assert.match(spec.query, /COUNT\(1\) FROM c WHERE c\.scanStatus = @pending AND c\.createdAt > @after/);
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
