'use strict';

/**
 * Sync-out pending hook against a stub repository and queue. The Eagle consumer's own lease rule
 * decides whether a create claim is still held.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cache = require('../../src/repositories/cache');
const eagle = require('../../src/sync-out/eagle');
const { reconcile } = require('../../src/sync-out/pending');
const { parseArgs } = require('../../src/scripts/sync-out-pending');

const KIND = 'commentPeriod';
const EAGLE_ID = '6720b3c0a1b2c3d4e5f60718';
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

function nativeRow(entry) {
  return {
    id: 'cp-native-1', projectId: 'p-207', sourceSystem: 'demi', eagleId: EAGLE_ID, syncVersion: 2,
    syncOut: { eagle: { sentVersion: 1, ...entry } }
  };
}

const lapsedCreate = () => nativeRow({ status: 'creating', claim: 'c-1', claimedAt: minutesAgo(10) });

function harness(rows) {
  const writes = [];
  const queued = [];
  const lines = [];
  const deps = {
    kind: KIND,
    repo: { listSyncPending: async () => rows, upsert: async (item) => writes.push(item) },
    consumers: [{ name: eagle.name, wants: () => true, inFlight: eagle.inFlight }],
    enqueue: async (row, options) => {
      queued.push({ id: row.id, options });
      return [eagle.name];
    }
  };
  const log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  return { deps, writes, queued, lines, log };
}

test('a create whose lease lapsed is listed and, on repair, queued once as a repair', async () => {
  const h = harness([lapsedCreate()]);
  const report = await reconcile({ repair: true, log: h.log }, h.deps);
  assert.deepStrictEqual(report.listed, ['cp-native-1']);
  assert.deepStrictEqual(h.queued, [{ id: 'cp-native-1', options: { repair: true, kind: KIND } }]);
});

test('a create claim still inside its lease is not queued', async () => {
  const h = harness([nativeRow({ status: 'creating', claim: 'c-1', claimedAt: minutesAgo(0.5) })]);
  await reconcile({ repair: true, log: h.log }, h.deps);
  assert.strictEqual(h.queued.length, 0);
});

test('a row whose sentVersion is current is not queued', async () => {
  const h = harness([nativeRow({ status: 'sent', sentVersion: 2 })]);
  await reconcile({ repair: true, log: h.log }, h.deps);
  assert.strictEqual(h.queued.length, 0);
});

test('without repair nothing is queued', async () => {
  const h = harness([lapsedCreate()]);
  await reconcile({ log: h.log }, h.deps);
  assert.strictEqual(h.queued.length, 0);
});

test('a store run writes nothing and logs the count line', async (t) => {
  const put = t.mock.method(cache, 'put', async () => {});
  const h = harness([lapsedCreate()]);
  await reconcile({ store: true, log: h.log }, h.deps);
  assert.strictEqual(h.writes.length + put.mock.callCount(), 0);
  assert.deepStrictEqual(h.lines, [`[sync-out pending] ${KIND}: 1 pending, 0 queued`]);
});

test('the CLI refuses a kind sync-out does not register', () => {
  assert.throws(() => parseArgs(['--kind', 'nope']), /usage/);
});
