'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without a collection rule.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const commentPeriods = require('../../src/repositories/comment-periods');
const comments = require('../../src/repositories/comments');
const projects = require('../../src/repositories/projects');
const notifications = require('../../src/repositories/notifications');
const { DELETED_CEILING } = require('../../src/repositories/documents');
const { resolveAccess, levelOfRead, canRead } = require('../../src/helpers/access-sql');
const syncOut = require('../../src/sync-out');
const { COMMENT_PERIOD } = require('../../src/sync-out/kinds');
const period = require('../../src/domain/comment-periods');
const { logger } = require('../../src/utils/logger');

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

const PROJECT_ID = 'p-public';
const PRIVATE_PROJECT_ID = 'p-private';
const NOTIFICATION_ID = '5c1f7a3e9b1d2c0012345678';
const PERIOD_ID = '5c1f7a3e9b1d2c0012340001';
const STORED = Object.freeze({
  id: PERIOD_ID, eagleId: PERIOD_ID, projectId: PROJECT_ID, sourceSystem: 'eagle',
  instructions: 'old', dateAdded: '2024-01-01T00:00:00.000Z', addedBy: 'idir-first',
  read: ['staff', 'sysadmin'], isPublished: false, sources: { eagle: { read: ['staff', 'sysadmin'] } }, _etag: 'e1'
});
const PROJECTS = {
  [PROJECT_ID]: { id: PROJECT_ID, read: ['public', 'staff', 'sysadmin'] },
  [PRIVATE_PROJECT_ID]: { id: PRIVATE_PROJECT_ID, read: ['staff', 'sysadmin'] },
  'p-sysadmin': { id: 'p-sysadmin', read: ['sysadmin'] }
};

function ctxFor(roles, username = 'idir-staff') {
  const req = { user: { sub: 'kc-1', preferred_username: username, realm_access: { roles } }, headers: {} };
  return { access: resolveAccess(req), req };
}
const STAFF = ctxFor(['staff']);

/** Fake storage: one stored period, its parents, and the comment cascade. Returns what was written. */
function fakeStore(t, stored = STORED, { cascadeFails = 0 } = {}) {
  const store = { written: [], deleted: [], cascades: [], queued: [] };
  t.mock.method(commentPeriods, 'getById', async (access, id) => stored && id === stored.id ? { ...stored } : null);
  t.mock.method(commentPeriods, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
  t.mock.method(syncOut, 'enqueueQuietly', async (row, { kind }) => { store.queued.push([row.id, row._etag, kind]); return []; });
  t.mock.method(commentPeriods, 'deleteById', async (...args) => { store.deleted.push(args); return true; });
  // As the repository answers: null for a project the caller may not read.
  t.mock.method(projects, 'getById', async (access, id) =>
    (PROJECTS[id] && canRead(PROJECTS[id], access, projects.PARTITION_FIELD) ? PROJECTS[id] : null));
  t.mock.method(notifications, 'getById', async (access, id) => id === NOTIFICATION_ID ? { id, read: ['public'] } : null);
  t.mock.method(comments, 'setAclForPeriod', async (access, periodId, read) => {
    store.cascades.push({ periodId, read, deletedYet: store.deleted.length > 0 });
    return { succeeded: 3 - cascadeFails, failed: cascadeFails };
  });
  return store;
}

async function audited(fn) {
  // Drain what an earlier test left batched, so rows hold only this call's events.
  await audit.flush();
  rows = [];
  const result = await fn();
  await audit.flush();
  return { result, rows };
}

test('comment period domain', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('create stores a DEMI row with commentIdCount 0, the caller and dateAdded stamped', async (t) => {
    const store = fakeStore(t, null);

    const { result, rows } = await audited(() => period.create(STAFF, {
      projectId: PROJECT_ID, instructions: 'Tell us', dateStarted: '2026-11-01T08:00:00Z'
    }));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, true);
    const row = store.written[0];
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.strictEqual(row.projectId, PROJECT_ID);
    assert.strictEqual(row.commentIdCount, 0);
    assert.strictEqual(row.addedBy, 'idir-staff');
    assert.ok(Number.isFinite(Date.parse(row.dateAdded)));
    assert.strictEqual(row.instructions, 'Tell us');
    assert.strictEqual(levelOfRead(row.read), 2);
    assert.strictEqual(row.isPublished, false);
    assert.strictEqual(rows[0].Action, 'commentPeriod.create');
    assert.deepStrictEqual(rows[0].Detail.fields.sort(), ['dateStarted', 'instructions', 'projectId']);
    assert.deepStrictEqual(store.queued, [[row.id, 'e2', COMMENT_PERIOD]]);
  });

  await t.test('create with isPublished under a public project reads public', async (t) => {
    const store = fakeStore(t, null);
    const { result } = await audited(() => period.create(STAFF, { projectId: PROJECT_ID, isPublished: true }));
    assert.strictEqual(result.status, 'ok');
    assert.ok(store.written[0].read.includes('public'));
    assert.strictEqual(store.written[0].isPublished, true);
    assert.ok(store.written[0].sources.demi.read.includes('public'));
  });

  await t.test('create ignores a body read: only isPublished opens a period', async (t) => {
    const store = fakeStore(t, null);
    const { result } = await audited(() => period.create(STAFF, { projectId: PROJECT_ID, read: ['public'] }));
    assert.strictEqual(result.status, 'ok');
    assert.ok(!store.written[0].read.includes('public'));
  });

  await t.test('create published under a private project is a conflict and writes nothing', async (t) => {
    const store = fakeStore(t, null);
    const result = await period.create(STAFF, { projectId: PRIVATE_PROJECT_ID, isPublished: true });
    assert.strictEqual(result.status, 'conflict');
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('create under a project DEMI does not hold is a 400 on projectId', async (t) => {
    const store = fakeStore(t, null);
    const result = await period.create(STAFF, { projectId: 'p-none' });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.projectId);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('create under a project the caller cannot read answers as an unknown project', async (t) => {
    const store = fakeStore(t, null);
    const hidden = await period.create(STAFF, { projectId: 'p-sysadmin' });
    const missing = await period.create(STAFF, { projectId: 'p-none' });
    assert.deepStrictEqual(hidden, missing);
    assert.strictEqual(hidden.status, 'invalid');
    assert.strictEqual(store.written.length, 0);

    const admin = await period.create(ctxFor(['sysadmin']), { projectId: 'p-sysadmin' });
    assert.strictEqual(admin.status, 'ok');
    assert.deepStrictEqual(store.written[0].read, ['sysadmin']);
  });

  await t.test('create without projectId is a 400', async (t) => {
    fakeStore(t, null);
    const result = await period.create(STAFF, { instructions: 'x' });
    assert.strictEqual(result.status, 'invalid');
    assert.strictEqual(result.fields.projectId, 'is required');
  });

  await t.test('create takes openHouses objects and relatedDocuments strings', async (t) => {
    const store = fakeStore(t, null);
    const openHouses = [{ eventDate: '2026-11-03', description: 'Hall' }];
    const { result } = await audited(() => period.create(STAFF, {
      projectId: PROJECT_ID, openHouses, relatedDocuments: ['doc-1']
    }));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.written[0].openHouses, openHouses);
    assert.deepStrictEqual(store.written[0].relatedDocuments, ['doc-1']);
  });

  await t.test('a malformed openHouses list is a field error beside the schema ones', async (t) => {
    fakeStore(t, null);
    const result = await period.create(STAFF, { projectId: PROJECT_ID, openHouses: ['x'], commentTip: 7 });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.openHouses);
    assert.ok(result.fields.commentTip);
  });

  await t.test('an openHouses entry with a non-string value is a field error', async (t) => {
    const store = fakeStore(t, null);
    const result = await period.create(STAFF, {
      projectId: PROJECT_ID, openHouses: [{ eventDate: '2026-11-03', attendees: 40 }]
    });
    assert.strictEqual(result.status, 'invalid');
    assert.strictEqual(result.fields.openHouses, 'must be an array of at most 50 entries');
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('update writes the listed fields, keeps project and dateAdded, stamps updatedBy', async (t) => {
    const store = fakeStore(t);

    const { result, rows } = await audited(() => period.update(STAFF, PERIOD_ID, { instructions: 'new' }));

    assert.strictEqual(result.status, 'ok');
    const row = store.written[0];
    assert.strictEqual(row.instructions, 'new');
    assert.strictEqual(row.projectId, PROJECT_ID);
    assert.strictEqual(row.dateAdded, STORED.dateAdded);
    assert.strictEqual(row.updatedBy, 'idir-staff');
    assert.strictEqual(rows[0].Action, 'commentPeriod.update');
    assert.deepStrictEqual(rows[0].Detail.fields, ['instructions']);
    assert.deepStrictEqual(store.queued, [[PERIOD_ID, 'e2', COMMENT_PERIOD]]);
  });

  await t.test('update of an Eagle period sets sourceSystem demi and queues commentPeriod', async (t) => {
    const store = fakeStore(t);
    const info = t.mock.method(logger, 'info');

    const { result } = await audited(() => period.update(STAFF, PERIOD_ID, { instructions: 'new' }));

    assert.strictEqual(result.status, 'ok');
    const row = store.written[0];
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.deepStrictEqual(row.sources.demi.read, STORED.sources.eagle.read);
    assert.deepStrictEqual(row.sources.eagle, STORED.sources.eagle, 'the raw Eagle copy is kept');
    assert.strictEqual(levelOfRead(row.read), 2);
    assert.deepStrictEqual(store.queued, [[PERIOD_ID, 'e2', COMMENT_PERIOD]]);
    const took = info.mock.calls.filter(c => c.arguments[0] === '[CommentPeriod] DEMI write took over an Eagle period');
    assert.deepStrictEqual(took.map(c => c.arguments[1]), [{ id: PERIOD_ID, eagleId: PERIOD_ID }]);
  });

  await t.test('takeover of a public Eagle period under a staff project keeps public as its own read only', async (t) => {
    const store = fakeStore(t, { ...STORED, projectId: PRIVATE_PROJECT_ID, sources: { eagle: { read: ['public', 'staff', 'sysadmin'] } } });
    await audited(() => period.update(STAFF, PERIOD_ID, { instructions: 'new' }));
    const row = store.written[0];
    assert.ok(row.sources.demi.read.includes('public'));
    assert.ok(!row.read.includes('public'));
    assert.strictEqual(row.isPublished, false);
  });

  await t.test('takeover of a period whose parent is gone keeps its stored read', async (t) => {
    const stored = { ...STORED, projectId: 'p-gone', sources: { eagle: { read: ['public', 'staff', 'sysadmin'] } } };
    const store = fakeStore(t, stored);
    await audited(() => period.update(STAFF, PERIOD_ID, { instructions: 'new' }));
    assert.deepStrictEqual(store.written[0].read, stored.read);
  });

  await t.test('a write that lost its race to another takeover logs none', async (t) => {
    const store = fakeStore(t);
    const info = t.mock.method(logger, 'info');
    const owned = { ...STORED, sourceSystem: 'demi', sources: { demi: { read: ['staff'] } }, _etag: 'e3' };
    let reads = 0;
    t.mock.method(commentPeriods, 'getById', async () => ({ ...(reads++ === 0 ? STORED : owned) }));
    let tries = 0;
    t.mock.method(commentPeriods, 'upsert', async (row) => {
      if (tries++ === 0) throw Object.assign(new Error('precondition'), { code: 412 });
      store.written.push(row);
      return { ...row, _etag: 'e4' };
    });

    const { result } = await audited(() => period.update(STAFF, PERIOD_ID, { instructions: 'new' }));

    assert.strictEqual(result.status, 'ok');
    assert.ok(!info.mock.calls.some(c => String(c.arguments[0]).includes('took over')));
  });

  await t.test('a write on a period DEMI already owns logs no takeover', async (t) => {
    fakeStore(t, { ...STORED, sourceSystem: 'demi', sources: { demi: { read: ['staff', 'sysadmin'] } } });
    const info = t.mock.method(logger, 'info');
    await audited(() => period.update(STAFF, PERIOD_ID, { instructions: 'new' }));
    assert.ok(!info.mock.calls.some(c => String(c.arguments[0]).includes('took over')));
  });

  await t.test('publish of an Eagle period takes it over with the published read as its own', async (t) => {
    const store = fakeStore(t);
    await audited(() => period.publish(STAFF, PERIOD_ID));
    assert.strictEqual(store.written[0].sourceSystem, 'demi');
    assert.ok(store.written[0].sources.demi.read.includes('public'));
  });

  await t.test('update ignores read and isPublished in the body', async (t) => {
    const store = fakeStore(t);
    const { result } = await audited(() => period.update(STAFF, PERIOD_ID, {
      instructions: 'new', read: ['public'], isPublished: true
    }));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.written[0].read, ['staff'], 'the staff read Eagle gave, under the project');
    assert.strictEqual(store.written[0].isPublished, false);
  });

  await t.test('update naming projectId is a 400: a PUT never moves a period', async (t) => {
    const store = fakeStore(t);
    const result = await period.update(STAFF, PERIOD_ID, { projectId: PRIVATE_PROJECT_ID });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.projectId);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('an update body left empty once read is dropped is a 400', async (t) => {
    const store = fakeStore(t);
    const result = await period.update(STAFF, PERIOD_ID, { read: ['public'] });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.body);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('update of a missing period is not-found', async (t) => {
    fakeStore(t, null);
    const result = await period.update(STAFF, PERIOD_ID, { instructions: 'new' });
    assert.strictEqual(result.status, 'not-found');
  });

  for (const [name, run] of [
    ['update', () => period.update(STAFF, PERIOD_ID, { instructions: 'new' })],
    ['delete', () => period.remove(STAFF, PERIOD_ID)],
    ['publish', () => period.publish(STAFF, PERIOD_ID)],
    ['unpublish', () => period.unpublish(STAFF, PERIOD_ID)]
  ]) {
    await t.test(`${name} of an ENGAGE period is a conflict and writes nothing`, async (t) => {
      const store = fakeStore(t, { ...STORED, sourceSystem: 'engage' });
      const result = await run();
      assert.strictEqual(result.status, 'conflict');
      assert.match(result.error, /ENGAGE/);
      assert.strictEqual(store.written.length + store.deleted.length + store.cascades.length, 0);
    });
  }

  await t.test('delete of an Eagle period keeps it flagged at DELETED_CEILING and queues it', async (t) => {
    const store = fakeStore(t, { ...STORED, read: ['public', 'staff', 'sysadmin'], isPublished: true });

    const { result, rows } = await audited(() => period.remove(STAFF, PERIOD_ID));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(store.deleted.length, 0);
    const row = store.written[0];
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.strictEqual(row.isDeleted, true);
    assert.strictEqual(row.isPublished, false);
    assert.strictEqual(levelOfRead(row.read), levelOfRead(DELETED_CEILING));
    assert.deepStrictEqual(store.cascades, [{ periodId: PERIOD_ID, read: DELETED_CEILING, deletedYet: false }]);
    assert.deepStrictEqual(store.queued, [[PERIOD_ID, 'e2', COMMENT_PERIOD]]);
    assert.strictEqual(rows[0].Action, 'commentPeriod.delete');
  });

  await t.test('delete of a DEMI period Eagle holds keeps a deleted staff-only row and queues it', async (t) => {
    const store = fakeStore(t, { ...STORED, sourceSystem: 'demi', read: ['public', 'staff', 'sysadmin'], isPublished: true });

    const { result, rows } = await audited(() => period.remove(STAFF, PERIOD_ID));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(store.deleted.length, 0);
    const row = store.written[0];
    assert.strictEqual(row.isDeleted, true);
    assert.strictEqual(row.isPublished, false);
    assert.strictEqual(levelOfRead(row.read), 2);
    assert.deepStrictEqual(store.queued, [[PERIOD_ID, 'e2', COMMENT_PERIOD]]);
    assert.strictEqual(rows[0].Action, 'commentPeriod.delete');
  });

  await t.test('delete that loses its etag to a sync-out create claim keeps the claimed row as deleted', async (t) => {
    const loaded = { ...STORED, sourceSystem: 'demi', eagleId: null };
    const store = fakeStore(t, loaded);
    let reads = 0;
    t.mock.method(commentPeriods, 'getById', async () => (++reads === 1 ? { ...loaded } : { ...loaded, eagleId: PERIOD_ID, _etag: 'e3' }));
    t.mock.method(commentPeriods, 'deleteById', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });

    const { result } = await audited(() => period.remove(STAFF, PERIOD_ID));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(store.written[0].isDeleted, true);
    assert.strictEqual(store.written[0].eagleId, PERIOD_ID);
    assert.deepStrictEqual(store.queued, [[PERIOD_ID, 'e2', COMMENT_PERIOD]]);
  });

  await t.test('delete of a DEMI period Eagle never got hard-deletes it after its comments drop to staff', async (t) => {
    const store = fakeStore(t, { ...STORED, sourceSystem: 'demi', eagleId: null });
    const { result } = await audited(() => period.remove(STAFF, PERIOD_ID));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.deleted, [[PERIOD_ID, PROJECT_ID, 'e1']]);
    assert.deepStrictEqual(store.cascades, [{ periodId: PERIOD_ID, read: DELETED_CEILING, deletedYet: false }]);
    assert.strictEqual(store.written.length, 0);
    assert.strictEqual(store.queued.length, 0);
  });

  await t.test('publish opens the period and cascades its read to the comments', async (t) => {
    const store = fakeStore(t);

    const { result, rows } = await audited(() => period.publish(STAFF, PERIOD_ID));

    assert.strictEqual(result.status, 'ok');
    const row = store.written[0];
    assert.strictEqual(row.isPublished, true);
    assert.ok(row.read.includes('public'));
    assert.deepStrictEqual(store.cascades.map(c => c.read), [row.read]);
    assert.strictEqual(rows[0].Action, 'commentPeriod.publish');
    assert.deepStrictEqual(rows[0].Detail.fields, ['isPublished']);
    assert.deepStrictEqual(store.queued, [[PERIOD_ID, 'e2', COMMENT_PERIOD]]);
  });

  await t.test('publish under a private project is a conflict and writes nothing', async (t) => {
    const store = fakeStore(t, { ...STORED, projectId: PRIVATE_PROJECT_ID });
    const result = await period.publish(STAFF, PERIOD_ID);
    assert.strictEqual(result.status, 'conflict');
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('publish under a notification has no project ceiling', async (t) => {
    const store = fakeStore(t, { ...STORED, projectId: NOTIFICATION_ID });
    const { result } = await audited(() => period.publish(STAFF, PERIOD_ID));
    assert.strictEqual(result.status, 'ok');
    assert.ok(store.written[0].read.includes('public'));
  });

  await t.test('unpublish closes the period and narrows its comments', async (t) => {
    const store = fakeStore(t, { ...STORED, read: ['public', 'staff', 'sysadmin'], isPublished: true });

    const { result, rows } = await audited(() => period.unpublish(STAFF, PERIOD_ID));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(store.written[0].isPublished, false);
    assert.ok(!store.written[0].read.includes('public'));
    assert.deepStrictEqual(store.cascades.map(c => c.read), [store.written[0].read]);
    assert.strictEqual(rows[0].Action, 'commentPeriod.unpublish');
    assert.deepStrictEqual(store.queued, [[PERIOD_ID, 'e2', COMMENT_PERIOD]]);
  });

  await t.test('publish of a DEMI row records its own read for the project cascade', async (t) => {
    const store = fakeStore(t, { ...STORED, sourceSystem: 'demi', sources: { demi: { read: ['staff', 'sysadmin'] } } });
    await audited(() => period.publish(STAFF, PERIOD_ID));
    assert.ok(store.written[0].sources.demi.read.includes('public'));
  });

  await t.test('a comment cascade that partly fails throws, so the caller gets a 500 and retries', async (t) => {
    const store = fakeStore(t, STORED, { cascadeFails: 1 });
    await assert.rejects(() => period.publish(STAFF, PERIOD_ID), /comments were not fully updated/);
    assert.strictEqual(store.written.length, 1);
    assert.strictEqual(store.queued.length, 1);
  });
});
