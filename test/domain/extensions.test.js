'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without a collection rule.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const projects = require('../../src/repositories/projects');
const { resolveAccess } = require('../../src/helpers/access-sql');
const extension = require('../../src/domain/extensions');

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

const PROJECT_ID = 'eagle-5c1f7a3e9b1d2c0012340001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTENSION = Object.freeze({
  type: 'Extension', appliedTo: 'Application review', start: '2020-01-01T08:00:00.000Z', end: '2020-02-01T08:00:00.000Z'
});
const SUSPENSION = Object.freeze({
  type: 'Suspension', appliedTo: 'Assessment', start: '2020-03-01T08:00:00.000Z', end: '2020-04-01T08:00:00.000Z'
});
const STORED = Object.freeze({
  id: PROJECT_ID, read: ['public', 'staff', 'sysadmin'], isPublished: true,
  review180Start: '2019-12-01T08:00:00.000Z',
  reviewExtensions: [EXTENSION], reviewSuspensions: [SUSPENSION], _etag: 'e1'
});

function ctxFor(roles) {
  const req = { user: { sub: 'kc-1', preferred_username: 'idir-staff', realm_access: { roles } }, headers: {} };
  return { access: resolveAccess(req), req };
}
const STAFF = ctxFor(['staff']);

/** Fake storage holding one project; returns the rows written. */
function fakeStore(t, stored = STORED) {
  const store = { written: [] };
  t.mock.method(projects, 'getById', async (access, id) => (id === stored.id ? structuredClone(stored) : null));
  t.mock.method(projects, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
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

const extId = extension.idOf(EXTENSION);
const susId = extension.idOf(SUSPENSION);

test('extension domain', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('list gives each Eagle item an id that is the same on every read', async (t) => {
    fakeStore(t);
    const first = await extension.list(STAFF.access, PROJECT_ID);
    const again = await extension.list(STAFF.access, PROJECT_ID);
    assert.strictEqual(first.reviewExtensions[0].id, extId);
    assert.strictEqual(first.reviewSuspensions[0].id, susId);
    assert.notStrictEqual(extId, susId);
    assert.strictEqual(again.reviewExtensions[0].id, extId);
  });

  await t.test('an item id ignores key order', () => {
    const reordered = { end: EXTENSION.end, start: EXTENSION.start, appliedTo: EXTENSION.appliedTo, type: EXTENSION.type };
    assert.strictEqual(extension.idOf(reordered), extId);
  });

  await t.test('list of an unknown project is null', async (t) => {
    fakeStore(t);
    assert.strictEqual(await extension.list(STAFF.access, 'eagle-nope'), null);
  });

  await t.test('create of type Extension appends to reviewExtensions with a UUID, audited', async (t) => {
    const store = fakeStore(t);
    const body = { type: 'Extension', appliedTo: 'Second', start: '2021-01-01', end: null };

    const { result, rows } = await audited(() => extension.create(STAFF, PROJECT_ID, body));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, true);
    const saved = store.written[0].reviewExtensions;
    assert.strictEqual(saved.length, 2);
    assert.deepStrictEqual(saved[0], EXTENSION, 'the Eagle item is stored unchanged');
    assert.match(saved[1].id, UUID);
    assert.strictEqual(saved[1].appliedTo, 'Second');
    assert.strictEqual(result.value.reviewExtensions[1].id, saved[1].id);
    assert.strictEqual(rows[0].Action, 'extension.create');
    assert.strictEqual(rows[0].ProjectId, PROJECT_ID);
    assert.deepStrictEqual(rows[0].Detail, { list: 'reviewExtensions', extensionId: saved[1].id });
  });

  await t.test('create of any other type, or none, goes to reviewSuspensions', async (t) => {
    const store = fakeStore(t);
    await extension.create(STAFF, PROJECT_ID, { type: 'Pause', appliedTo: 'x' });
    await extension.create(STAFF, PROJECT_ID, { appliedTo: 'y' });
    assert.strictEqual(store.written[0].reviewSuspensions.at(-1).type, 'Pause');
    assert.strictEqual(store.written[1].reviewSuspensions.at(-1).appliedTo, 'y');
    assert.strictEqual(store.written[1].reviewExtensions.length, 1);
  });

  await t.test('no write recalculates the review timeline', async (t) => {
    const store = fakeStore(t);
    await extension.create(STAFF, PROJECT_ID, { type: 'Extension', end: '2030-01-01' });
    assert.strictEqual(store.written[0].review180Start, STORED.review180Start);
  });

  await t.test('a body with an unknown key, an id, or no field is a 400 that writes nothing', async (t) => {
    const store = fakeStore(t);
    const unknown = await extension.create(STAFF, PROJECT_ID, { type: 'Extension', days: 30 });
    const withId = await extension.create(STAFF, PROJECT_ID, { type: 'Extension', id: 'mine' });
    const empty = await extension.create(STAFF, PROJECT_ID, {});
    assert.ok(unknown.fields.days);
    assert.ok(withId.fields.id);
    assert.ok(empty.fields.body);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('create under an unknown project is not-found', async (t) => {
    fakeStore(t);
    const result = await extension.create(STAFF, 'eagle-nope', { type: 'Extension' });
    assert.strictEqual(result.status, 'not-found');
  });

  await t.test('update replaces the item whole, keeps its id and moves it when the type changes', async (t) => {
    const store = fakeStore(t);
    const { result, rows } = await audited(() =>
      extension.update(STAFF, PROJECT_ID, extId, { type: 'Suspension', appliedTo: 'Moved' }));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, false);
    const row = store.written[0];
    assert.deepStrictEqual(row.reviewExtensions, []);
    assert.deepStrictEqual(row.reviewSuspensions.at(-1), { type: 'Suspension', appliedTo: 'Moved', id: extId });
    assert.strictEqual(rows[0].Action, 'extension.update');
  });

  await t.test('update or delete of an unknown item is not-found and writes nothing', async (t) => {
    const store = fakeStore(t);
    const updated = await extension.update(STAFF, PROJECT_ID, 'nope', { type: 'Extension' });
    const removed = await extension.remove(STAFF, PROJECT_ID, 'nope');
    assert.strictEqual(updated.status, 'not-found');
    assert.strictEqual(removed.status, 'not-found');
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('delete removes every equal Eagle item, as eagle-api\'s $pull did', async (t) => {
    const store = fakeStore(t, { ...STORED, reviewSuspensions: [SUSPENSION, { ...SUSPENSION }, { ...SUSPENSION, end: null }] });
    const { result, rows } = await audited(() => extension.remove(STAFF, PROJECT_ID, susId));

    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.written[0].reviewSuspensions, [{ ...SUSPENSION, end: null }]);
    assert.strictEqual(rows[0].Action, 'extension.delete');
    assert.deepStrictEqual(rows[0].Detail, { list: 'reviewSuspensions', extensionId: susId });
  });

  await t.test('a DEMI item is found by its stored id', async (t) => {
    const demi = { type: 'Extension', appliedTo: 'Ours', id: '0b0c4f1e-7a43-4b3a-9a39-6f7e2b1d2c3e' };
    const store = fakeStore(t, { ...STORED, reviewExtensions: [EXTENSION, demi] });
    await extension.remove(STAFF, PROJECT_ID, demi.id);
    assert.deepStrictEqual(store.written[0].reviewExtensions, [EXTENSION]);
  });

  await t.test('a list a project dial hides from the caller cannot be written', async (t) => {
    const store = fakeStore(t, { ...STORED, vis: { reviewSuspensions: 1 } });
    const result = await extension.remove(STAFF, PROJECT_ID, susId);
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.reviewSuspensions);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('update cannot move an item out of a list a project dial hides from the caller', async (t) => {
    const store = fakeStore(t, { ...STORED, vis: { reviewSuspensions: 1 } });
    const result = await extension.update(STAFF, PROJECT_ID, susId, { type: 'Extension', appliedTo: 'Moved' });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.reviewSuspensions);
    assert.strictEqual(store.written.length, 0);
  });
});
