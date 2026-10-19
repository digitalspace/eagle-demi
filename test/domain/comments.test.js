'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without a collection rule.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const comments = require('../../src/repositories/comments');
const commentPeriods = require('../../src/repositories/comment-periods');
const { resolveAccess, levelOfRead } = require('../../src/helpers/access-sql');
const comment = require('../../src/domain/comments');

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

const PROJECT_ID = 'p-public';
const PERIOD_ID = '5c1f7a3e9b1d2c0012340001';
const PRIVATE_PERIOD_ID = '5c1f7a3e9b1d2c0012340002';
const COMMENT_ID = '5c1f7a3e9b1d2c0012350001';
const DOC_ID = '5c1f7a3e9b1d2c0012360001';
const PERIODS = {
  [PERIOD_ID]: { id: PERIOD_ID, projectId: PROJECT_ID, read: ['public', 'staff', 'sysadmin'] },
  [PRIVATE_PERIOD_ID]: { id: PRIVATE_PERIOD_ID, projectId: PROJECT_ID, read: ['staff', 'sysadmin'] }
};
const STORED = Object.freeze({
  id: COMMENT_ID, eagleId: COMMENT_ID, periodId: PERIOD_ID, projectId: PROJECT_ID, sourceSystem: 'eagle',
  comment: 'Keep the trail open', documents: [DOC_ID], eaoStatus: 'Pending', commentId: 7,
  dateAdded: '2024-01-01T00:00:00.000Z', read: ['staff', 'sysadmin'], isPublished: false, _etag: 'e1'
});

function ctxFor(roles, username = 'idir-staff') {
  const req = { user: { sub: 'kc-1', preferred_username: username, realm_access: { roles } }, headers: {} };
  return { access: resolveAccess(req), req };
}
const STAFF = ctxFor(['staff']);

/** Fake storage: one stored comment, its periods and the period counter. Returns what was written. */
function fakeStore(t, stored = STORED, { counter = 4 } = {}) {
  const store = { written: [], numbered: [] };
  let next = counter;
  t.mock.method(comments, 'getById', async (access, id) => stored && id === stored.id ? { ...stored } : null);
  t.mock.method(comments, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
  t.mock.method(commentPeriods, 'getById', async (access, id) => PERIODS[id] ? { ...PERIODS[id] } : null);
  t.mock.method(commentPeriods, 'nextCommentId', async (periodId, projectId) => {
    store.numbered.push([periodId, projectId]);
    return next === null ? null : ++next;
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

test('comment domain', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('create numbers the comment from its period counter and stores a DEMI row', async (t) => {
    const store = fakeStore(t, null);

    const { result, rows } = await audited(() => comment.create(STAFF, {
      periodId: PERIOD_ID, comment: 'Protect the creek', author: 'Pat', isAnonymous: false
    }));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, true);
    const row = store.written[0];
    assert.strictEqual(row.commentId, 5);
    assert.deepStrictEqual(store.numbered, [[PERIOD_ID, PROJECT_ID]]);
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.strictEqual(row.periodId, PERIOD_ID);
    assert.strictEqual(row.projectId, PROJECT_ID);
    assert.strictEqual(row.comment, 'Protect the creek');
    assert.strictEqual(row.addedBy, 'idir-staff');
    assert.strictEqual(rows[0].Action, 'comment.create');
  });

  await t.test('create with no status reads staff-only and stores no status', async (t) => {
    const store = fakeStore(t, null);
    await comment.create(STAFF, { periodId: PERIOD_ID });
    assert.strictEqual(store.written[0].eaoStatus, null);
    assert.strictEqual(levelOfRead(store.written[0].read), 2);
    assert.strictEqual(store.written[0].isPublished, false);
  });

  await t.test('create Published under a public period reads public and keeps datePosted', async (t) => {
    const store = fakeStore(t, null);
    await comment.create(STAFF, { periodId: PERIOD_ID, eaoStatus: 'Published', datePosted: '2026-10-01T00:00:00Z' });
    const row = store.written[0];
    assert.ok(row.read.includes('public'));
    assert.strictEqual(row.isPublished, true);
    assert.strictEqual(row.datePosted, '2026-10-01T00:00:00Z');
    assert.ok(row.sources.demi.read.includes('public'));
  });

  await t.test('create Pending drops datePosted', async (t) => {
    const store = fakeStore(t, null);
    await comment.create(STAFF, { periodId: PERIOD_ID, eaoStatus: 'Pending', datePosted: '2026-10-01T00:00:00Z' });
    assert.strictEqual(store.written[0].datePosted, null);
    assert.ok(!store.written[0].read.includes('public'));
  });

  await t.test('create Reset is stored Pending, staff-only', async (t) => {
    const store = fakeStore(t, null);
    await comment.create(STAFF, { periodId: PERIOD_ID, eaoStatus: 'Reset' });
    assert.strictEqual(store.written[0].eaoStatus, 'Pending');
    assert.strictEqual(levelOfRead(store.written[0].read), 2);
  });

  await t.test('create Published under an unpublished period stays private but keeps its own public read', async (t) => {
    const store = fakeStore(t, null);
    await comment.create(STAFF, { periodId: PRIVATE_PERIOD_ID, eaoStatus: 'Published' });
    const row = store.written[0];
    assert.ok(!row.read.includes('public'));
    assert.strictEqual(row.isPublished, false);
    assert.ok(row.sources.demi.read.includes('public'), 'the period cascade opens it on publish');
  });

  await t.test('a body read on create is a 400: only eaoStatus opens a comment', async (t) => {
    const store = fakeStore(t, null);
    const result = await comment.create(STAFF, { periodId: PERIOD_ID, read: ['public'] });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.read);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('create with a malformed document id is a 400 and takes no number', async (t) => {
    const store = fakeStore(t, null);
    const result = await comment.create(STAFF, { periodId: PERIOD_ID, documents: [DOC_ID, 'not-an-id'] });
    assert.strictEqual(result.status, 'invalid');
    assert.strictEqual(result.fields.documents, 'must be an array of ids');
    assert.strictEqual(store.numbered.length, 0);
  });

  await t.test('create with a malformed valued component id is a 400', async (t) => {
    fakeStore(t, null);
    const result = await comment.create(STAFF, { periodId: PERIOD_ID, valuedComponents: ['x'] });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.valuedComponents);
  });

  await t.test('create under a period DEMI does not hold is a 400 on periodId', async (t) => {
    const store = fakeStore(t, null);
    const result = await comment.create(STAFF, { periodId: '5c1f7a3e9b1d2c0012349999' });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.periodId);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('create is a 400 when the counter finds no period', async (t) => {
    const store = fakeStore(t, null, { counter: null });
    const result = await comment.create(STAFF, { periodId: PERIOD_ID });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.periodId);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('create without periodId is a 400', async (t) => {
    fakeStore(t, null);
    const result = await comment.create(STAFF, { comment: 'x' });
    assert.strictEqual(result.fields.periodId, 'is required');
  });

  await t.test('update writes the listed fields, keeps documents and the read, stamps updatedBy', async (t) => {
    const store = fakeStore(t);
    const { result, rows } = await audited(() => comment.update(STAFF, COMMENT_ID, { eaoNotes: 'checked' }));
    assert.strictEqual(result.status, 'ok');
    const row = store.written[0];
    assert.strictEqual(row.eaoNotes, 'checked');
    assert.deepStrictEqual(row.documents, [DOC_ID]);
    assert.deepStrictEqual(row.read, STORED.read);
    assert.strictEqual(row.updatedBy, 'idir-staff');
    assert.deepStrictEqual(rows[0].Detail.fields, ['eaoNotes']);
  });

  await t.test('update naming documents is a 400: a PUT never changes them', async (t) => {
    const store = fakeStore(t);
    const result = await comment.update(STAFF, COMMENT_ID, { documents: [DOC_ID] });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.documents);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('update with eaoStatus Published opens the comment', async (t) => {
    const store = fakeStore(t);
    await comment.update(STAFF, COMMENT_ID, { eaoStatus: 'Published' });
    assert.strictEqual(store.written[0].eaoStatus, 'Published');
    assert.ok(store.written[0].read.includes('public'));
    assert.strictEqual(store.written[0].isPublished, true);
  });

  await t.test('update of an Eagle row leaves its Eagle source alone', async (t) => {
    const store = fakeStore(t, { ...STORED, sources: { eagle: { read: ['staff'] } } });
    await comment.update(STAFF, COMMENT_ID, { eaoStatus: 'Published' });
    assert.deepStrictEqual(store.written[0].sources, { eagle: { read: ['staff'] } });
  });

  await t.test('an empty update body is a 400', async (t) => {
    fakeStore(t);
    const result = await comment.update(STAFF, COMMENT_ID, { dateUpdated: '2026-01-01' });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.body);
  });

  await t.test('update of a missing comment is not-found', async (t) => {
    const store = fakeStore(t);
    const result = await comment.update(STAFF, '5c1f7a3e9b1d2c0012359999', { eaoNotes: 'x' });
    assert.strictEqual(result.status, 'not-found');
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('status Published opens the comment under its period and stamps the caller', async (t) => {
    const store = fakeStore(t);
    const { result, rows } = await audited(() => comment.setStatus(STAFF, COMMENT_ID, { status: 'Published' }));
    assert.strictEqual(result.status, 'ok');
    assert.ok(store.written[0].read.includes('public'));
    assert.strictEqual(store.written[0].updatedBy, 'idir-staff');
    assert.strictEqual(rows[0].Action, 'comment.setStatus');
  });

  for (const status of ['Pending', 'Deferred', 'Rejected']) {
    await t.test(`status ${status} closes a published comment to staff`, async (t) => {
      const store = fakeStore(t, { ...STORED, eaoStatus: 'Published', read: ['public', 'staff', 'sysadmin'], isPublished: true });
      await comment.setStatus(STAFF, COMMENT_ID, { status });
      assert.strictEqual(store.written[0].eaoStatus, status);
      assert.strictEqual(levelOfRead(store.written[0].read), 2);
      assert.strictEqual(store.written[0].isPublished, false);
    });
  }

  await t.test('status Reset stores Pending', async (t) => {
    const store = fakeStore(t, { ...STORED, eaoStatus: 'Rejected' });
    await comment.setStatus(STAFF, COMMENT_ID, { status: 'Reset' });
    assert.strictEqual(store.written[0].eaoStatus, 'Pending');
  });

  await t.test('an unknown status is a 400 and writes nothing', async (t) => {
    const store = fakeStore(t);
    const result = await comment.setStatus(STAFF, COMMENT_ID, { status: 'Approved' });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.status);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('status of a comment whose period is gone is a conflict', async (t) => {
    const store = fakeStore(t, { ...STORED, periodId: '5c1f7a3e9b1d2c0012349999' });
    const result = await comment.setStatus(STAFF, COMMENT_ID, { status: 'Published' });
    assert.strictEqual(result.status, 'conflict');
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('a write that keeps losing its etag race is busy', async (t) => {
    fakeStore(t);
    t.mock.method(comments, 'upsert', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
    const result = await comment.setStatus(STAFF, COMMENT_ID, { status: 'Published' });
    assert.strictEqual(result.status, 'busy');
  });
});
