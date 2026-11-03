'use strict';

/**
 * Sync-out pending hook against a stub repository and queue. The Eagle consumer's own lease rule
 * decides whether a send claim (`creating`) is still held.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const queues = require('../../src/jobs/queue-client');
const commentPeriods = require('../../src/repositories/comment-periods');
const documents = require('../../src/repositories/documents');
const syncOut = require('../../src/sync-out');
const eagle = require('../../src/sync-out/eagle');
const eagleDocument = require('../../src/sync-out/eagle-document');
const lists = require('../../src/repositories/lists');
const projects = require('../../src/repositories/projects');
const notifications = require('../../src/repositories/notifications');
const updates = require('../../src/repositories/updates');
const { DOCUMENT, NOTIFICATION, ORGANIZATION, PROJECT, UPDATE, kindOf } = require('../../src/sync-out/kinds');
const { logger } = require('../../src/utils/logger');
const { depsFor, reconcile } = require('../../src/sync-out/pending');
const { parseArgs, run } = require('../../src/scripts/sync-out-pending');
const { useEnv } = require('../helpers/sync-out-eagle');

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
/** `row` holding a send claim whose lease lapsed. */
const lapsed = row =>
  ({ ...row, syncOut: { eagle: { ...row.syncOut.eagle, status: 'creating', claim: 'c-1', claimedAt: minutesAgo(10) } } });

function harness(rows, { wants = () => true, enabled = () => true, answer = async () => [eagle.name] } = {}) {
  const queued = [];
  const lines = [];
  const metas = [];
  const deps = {
    kind: KIND,
    repo: { listSyncPending: async () => rows },
    consumers: [{ name: eagle.name, enabled, enableSettings: eagle.enableSettings, wants, inFlight: eagle.inFlight }],
    enqueue: async (row, options) => {
      queued.push({ id: row.id, options });
      return answer(row);
    }
  };
  const record = (line, meta) => { lines.push(line); metas.push(meta); };
  const log = { info: record, warn: record };
  return { deps, queued, lines, metas, log };
}

test('a send claim whose lease lapsed is listed and, on repair, queued once as a repair', async () => {
  const h = harness([lapsedCreate()]);
  const report = await reconcile({ repair: true, log: h.log }, h.deps);
  assert.deepStrictEqual(report.listed, ['cp-native-1']);
  assert.deepStrictEqual(h.queued, [{ id: 'cp-native-1', options: { repair: true, kind: KIND } }]);
  assert.strictEqual(report.queued, 1);
  assert.deepStrictEqual(h.lines, [`[sync-out pending] ${KIND}: 1 pending, 1 queued, 0 stray`]);
});

test('a send claim still inside its lease is not queued', async () => {
  const h = harness([nativeRow({ status: 'creating', claim: 'c-1', claimedAt: minutesAgo(0.5) })]);
  await reconcile({ repair: true, log: h.log }, h.deps);
  assert.strictEqual(h.queued.length, 0);
});

test('a row whose sentVersion is current is not queued', async () => {
  const h = harness([nativeRow({ status: 'sent', sentVersion: 2 })]);
  await reconcile({ repair: true, log: h.log }, h.deps);
  assert.strictEqual(h.queued.length, 0);
});

test('a row no consumer wants is not listed', async () => {
  const h = harness([lapsedCreate()], { wants: () => false });
  const report = await reconcile({ log: h.log }, h.deps);
  assert.deepStrictEqual(report.listed, []);
});

test('without repair the row is listed and nothing is queued', async () => {
  const h = harness([lapsedCreate()]);
  const report = await reconcile({ log: h.log }, h.deps);
  assert.deepStrictEqual(report.listed, ['cp-native-1']);
  assert.strictEqual(h.queued.length, 0);
});

test('rows holding a stray Eagle id, even a null one, are counted as stray and never listed or queued', async () => {
  const h = harness([
    lapsedCreate(),
    { ...nativeRow({ status: 'failed', strayEagleId: null }), id: 'cp-stray-null' },
    { ...nativeRow({ status: 'failed', strayEagleId: '6720b3c0a1b2c3d4e5f6ffff' }), id: 'cp-stray-id' }
  ]);
  const report = await reconcile({ repair: true, log: h.log }, h.deps);
  assert.deepStrictEqual(report.listed, ['cp-native-1']);
  assert.deepStrictEqual(h.queued.map(q => q.id), ['cp-native-1']);
  assert.deepStrictEqual(report.failed, []);
  assert.deepStrictEqual(h.lines, [`[sync-out pending] ${KIND}: 1 pending, 1 queued, 2 stray`]);
  assert.strictEqual(h.metas[0].stray, 2);
});

test('a stray row whose version was already sent is not counted as stray', async () => {
  const h = harness([nativeRow({ status: 'sent', sentVersion: 2, strayEagleId: null })]);
  await reconcile({ log: h.log }, h.deps);
  assert.deepStrictEqual(h.lines, [`[sync-out pending] ${KIND}: 0 pending, 0 queued, 0 stray`]);
});

test('repair with every consumer disabled leaves stray rows out of failed', async () => {
  const h = harness([lapsedCreate(), { ...nativeRow({ strayEagleId: null }), id: 'cp-stray' }], { enabled: () => false });
  const report = await reconcile({ repair: true, log: h.log }, h.deps);
  assert.deepStrictEqual(report.failed, ['cp-native-1']);
});

test('a store run logs only the count line', async () => {
  const h = harness([lapsedCreate()]);
  await reconcile({ store: true, log: h.log }, h.deps);
  assert.deepStrictEqual(h.lines, [`[sync-out pending] ${KIND}: 1 pending, 0 queued, 0 stray`]);
});

test('a row whose enqueue throws lands in failed, logs a warning, and the next row is still queued', async () => {
  const h = harness([lapsedCreate(), { ...lapsedCreate(), id: 'cp-native-2' }], {
    answer: async (row) => (row.id === 'cp-native-1' ? Promise.reject(new Error('queue down')) : [eagle.name])
  });
  const report = await reconcile({ repair: true, log: h.log }, h.deps);
  assert.deepStrictEqual(report.failed, ['cp-native-1']);
  assert.match(h.lines[0], /could not re-queue row cp-native-1/);
  assert.deepStrictEqual(h.queued.map(q => q.id), ['cp-native-1', 'cp-native-2']);
  assert.strictEqual(report.queued, 1);
});

test('a row enqueue sends to no consumer lands in failed, is not counted as queued, and logs why', async () => {
  const h = harness([lapsedCreate()], { answer: async () => [] });
  const report = await reconcile({ repair: true, log: h.log }, h.deps);
  assert.deepStrictEqual(report.failed, ['cp-native-1']);
  assert.strictEqual(report.queued, 0);
  assert.deepStrictEqual(h.lines, [
    `[sync-out pending] ${KIND}: row cp-native-1 not re-queued: no enabled consumer took it`,
    `[sync-out pending] ${KIND}: 1 pending, 0 queued, 0 stray`
  ]);
});

test('repair with every consumer disabled fails the rows and names the setting', async () => {
  const h = harness([lapsedCreate()], { enabled: () => false });
  const report = await reconcile({ repair: true, log: h.log }, h.deps);
  assert.deepStrictEqual(report.failed, ['cp-native-1']);
  assert.match(h.lines[0], /needs SYNC_OUT_EAGLE_ENABLED true/);
});

test('depsFor wires a kind to its repository, its consumers and the sync-out enqueue', () => {
  const deps = depsFor(KIND);
  assert.strictEqual(deps.repo, commentPeriods);
  assert.deepStrictEqual(deps.consumers, [eagle]);
  assert.strictEqual(deps.enqueue, syncOut.enqueue);
  assert.deepStrictEqual(depsFor(DOCUMENT).consumers, [eagleDocument], 'not the comment period consumer of the same name');
});

test('the document hook re-queues only rows owed a send, a lapsed send claim included, and names both flags when the document one is off', async (t) => {
  useEnv(t, { SYNC_OUT_EAGLE_ENABLED: 'true', SYNC_OUT_EAGLE_DOCUMENT_ENABLED: 'true' });
  const docRow = (id, sentVersion) => ({
    id, projectId: '1234', sourceSystem: 'demi', eagleId: `eagle-${id}`, syncVersion: 3,
    syncOut: { eagle: { status: 'sent', sentVersion } }
  });
  t.mock.method(documents, 'listSyncPending', async () =>
    [docRow('owed', 2), docRow('current', 3), lapsed(docRow('lapsed', 2))]);
  const sent = [];
  t.mock.method(queues, 'queueClientFor', () => ({ sendMessage: async (body) => { sent.push(JSON.parse(body)); } }));
  const lines = [];
  const log = { info: () => {}, warn: (line) => { lines.push(line); } };

  const report = await kindOf(DOCUMENT).reconcile({ repair: true, log });

  assert.deepStrictEqual(sent, ['owed', 'lapsed'].map(id =>
    ({ kind: DOCUMENT, consumer: 'eagle', id, projectId: '1234', attempt: 1, repair: true })));
  assert.deepStrictEqual({ listed: report.listed, queued: report.queued, failed: report.failed },
    { listed: ['owed', 'lapsed'], queued: 2, failed: [] });

  delete process.env.SYNC_OUT_EAGLE_DOCUMENT_ENABLED;
  await kindOf(DOCUMENT).reconcile({ repair: true, log });
  assert.match(lines[0], /needs SYNC_OUT_EAGLE_ENABLED and SYNC_OUT_EAGLE_DOCUMENT_ENABLED true/);
  assert.strictEqual(sent.length, 2);
});

/** A DEMI-created row of a kind partitioned by id, sent through `sentVersion`. */
const idPartitionedRow = (id, sentVersion) => ({ id, projectId: null, sourceSystem: 'demi', eagleId: `e-${id}`,
  syncVersion: 3, syncOut: { eagle: { status: 'sent', sentVersion } } });

for (const { kind, flag, repo, row } of [
  { kind: ORGANIZATION, flag: 'SYNC_OUT_EAGLE_ORGANIZATION_ENABLED', repo: lists,
    row: (id, sentVersion) => ({ id, kind: 'Organization', projectId: null, sourceSystem: 'demi', eagleId: `e-${id}`,
      syncVersion: 3, syncOut: { eagle: { status: 'sent', sentVersion } } }) },
  { kind: PROJECT, flag: 'SYNC_OUT_EAGLE_PROJECT_ENABLED', repo: projects,
    row: (id, sentVersion) => ({ id, sourceSystem: 'track', sources: {}, eagleId: `e-${id}`,
      syncVersion: 3, syncOut: { eagle: { status: 'sent', sentVersion, mintedId: `e-${id}` } } }) },
  { kind: NOTIFICATION, flag: 'SYNC_OUT_EAGLE_NOTIFICATION_ENABLED', repo: notifications, row: idPartitionedRow },
  { kind: UPDATE, flag: 'SYNC_OUT_EAGLE_UPDATE_ENABLED', repo: updates, row: idPartitionedRow }
]) {
  test(`the ${kind} hook re-queues only rows owed a send, a lapsed send claim included, and names its flag when it is off`, async (t) => {
    useEnv(t, { SYNC_OUT_EAGLE_ENABLED: 'true', [flag]: 'true' });
    const listedWith = [];
    t.mock.method(repo, 'listSyncPending', async (...args) => {
      listedWith.push(args);
      return [row('owed', 2), row('current', 3), lapsed(row('lapsed', 2))];
    });
    const sent = [];
    t.mock.method(queues, 'queueClientFor', () => ({ sendMessage: async (body) => { sent.push(JSON.parse(body)); } }));
    const lines = [];
    const log = { info: () => {}, warn: (line) => { lines.push(line); } };

    const report = await kindOf(kind).reconcile({ repair: true, log });

    assert.deepStrictEqual(listedWith, [kind === ORGANIZATION ? ['Organization'] : []]);
    assert.deepStrictEqual(sent.map(m => [m.kind, m.id, m.repair]), [[kind, 'owed', true], [kind, 'lapsed', true]]);
    assert.deepStrictEqual({ listed: report.listed, queued: report.queued }, { listed: ['owed', 'lapsed'], queued: 2 });

    delete process.env[flag];
    await kindOf(kind).reconcile({ repair: true, log });
    assert.match(lines[0], new RegExp(`needs SYNC_OUT_EAGLE_ENABLED and ${flag} true`));
  });
}

test('the CLI run fails when a row was not re-queued', async (t) => {
  t.mock.method(logger, 'info', () => {});
  t.mock.method(logger, 'warn', () => {});
  const h = harness([lapsedCreate()], { enabled: () => false });
  await assert.rejects(run({ kind: KIND, repair: true }, (o) => reconcile(o, h.deps)),
    /1 row\(s\) not re-queued: cp-native-1/);
});

test('the CLI run fails when enqueue sent a row to no consumer', async (t) => {
  t.mock.method(logger, 'info', () => {});
  t.mock.method(logger, 'warn', () => {});
  const h = harness([lapsedCreate()], { answer: async () => [] });
  await assert.rejects(run({ kind: KIND, repair: true }, (o) => reconcile(o, h.deps)),
    /1 row\(s\) not re-queued: cp-native-1/);
});

test('the CLI run names a thrown ENGAGE pass and failed pending rows in one message', async () => {
  await assert.rejects(run({ kind: KIND, repair: true }, async () => ({ failed: ['r-1'], engage: { error: 'engage down' } })),
    { message: 'ENGAGE checks failed: engage down; 1 row(s) not re-queued: r-1' });
});

test('the CLI refuses a kind sync-out does not register', () => {
  assert.throws(() => parseArgs(['--kind', 'nope']), /usage/);
});
