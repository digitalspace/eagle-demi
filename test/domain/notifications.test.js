'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without a collection rule.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const notifications = require('../../src/repositories/notifications');
const updates = require('../../src/repositories/updates');
const { resolveAccess, levelOfRead } = require('../../src/helpers/access-sql');
const notification = require('../../src/domain/notifications');

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

const NOTIFICATION_ID = '5c1f7a3e9b1d2c0012390001';
const STORED = Object.freeze({
  id: NOTIFICATION_ID, eagleId: NOTIFICATION_ID, sourceSystem: 'eagle', name: 'Mine expansion',
  type: 'Mines', region: 'Kootenay', decision: 'In Progress', pcp: 'open', isMet: true,
  metURL: 'https://engage.example/mine', dateStarted: '2026-09-01T00:00:00.000Z', centroid: [49.5, -117.3],
  notificationThresholdValue: 75, dateAdded: '2020-01-01T00:00:00.000Z',
  read: ['public', 'staff', 'sysadmin'], isPublished: true, _etag: 'e1'
});

function ctxFor(roles, username = 'idir-staff') {
  const req = { user: { sub: 'kc-1', preferred_username: username, realm_access: { roles } }, headers: {} };
  return { access: resolveAccess(req), req };
}
const STAFF = ctxFor(['staff']);

/** Fake storage holding `stored`; returns what was written and how often the parent cache was dropped. */
function fakeStore(t, stored = STORED) {
  const store = { written: [], forgotten: 0 };
  t.mock.method(notifications, 'getById', async (access, id) => stored && id === stored.id ? { ...stored } : null);
  t.mock.method(notifications, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
  t.mock.method(updates, 'forgetParents', () => { store.forgotten++; });
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

test('notification domain', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('create stores an unpublished staff-only DEMI row with every field defaulted', async (t) => {
    const store = fakeStore(t, null);

    const { result, rows } = await audited(() => notification.create(STAFF, { name: 'Quarry', region: 'Omineca' }));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, true);
    const row = store.written[0];
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.strictEqual(row.eagleId, null);
    assert.strictEqual(row.name, 'Quarry');
    assert.strictEqual(row.region, 'Omineca');
    assert.strictEqual(row.type, null);
    assert.strictEqual(row.pcp, 'none');
    assert.strictEqual(row.isMet, false);
    assert.strictEqual(row.metURL, '');
    assert.deepStrictEqual(row.centroid, []);
    assert.strictEqual(row.addedBy, 'idir-staff');
    assert.deepStrictEqual([...row.read].sort(), ['staff', 'sysadmin'], "eagle-api's SECURE_ROLES");
    assert.strictEqual(row.isPublished, false);
    assert.strictEqual(row.write, undefined, 'route guards hold the write rule, not the row');
    assert.strictEqual(row.delete, undefined);
    assert.strictEqual(rows[0].Action, 'notification.create');
    assert.strictEqual(store.forgotten, 1, 'the Update parent gate drops its cached reads');
  });

  await t.test('create with isPublished true adds public to the read', async (t) => {
    const store = fakeStore(t, null);
    await audited(() => notification.create(STAFF, { name: 'Quarry', isPublished: true }));
    assert.strictEqual(levelOfRead(store.written[0].read), 4);
    assert.strictEqual(store.written[0].isPublished, true);
  });

  await t.test('create ignores a read in the body', async (t) => {
    const store = fakeStore(t, null);
    await audited(() => notification.create(STAFF, { name: 'Quarry', read: ['public'] }));
    assert.strictEqual(store.written[0].isPublished, false);
    assert.ok(!store.written[0].read.includes('public'));
  });

  await t.test('create refuses an unknown key, a bad number and a bad centroid, and stores nothing', async (t) => {
    const store = fakeStore(t, null);
    const { result, rows } = await audited(() => notification.create(STAFF, {
      name: 'Quarry', owner: 'x', notificationThresholdValue: '75', centroid: [1, 2, 3]
    }));
    assert.strictEqual(result.status, 'invalid');
    assert.deepStrictEqual(Object.keys(result.fields).sort(), ['centroid', 'notificationThresholdValue', 'owner']);
    assert.strictEqual(store.written.length, 0);
    assert.strictEqual(rows.length, 0);
  });

  await t.test('create keeps a centroid of numeric strings, as eagle-admin sends it', async (t) => {
    const store = fakeStore(t, null);
    await audited(() => notification.create(STAFF, { centroid: ['49.5', '-117.3'], notificationThresholdValue: 12 }));
    assert.deepStrictEqual(store.written[0].centroid, ['49.5', '-117.3']);
    assert.strictEqual(store.written[0].notificationThresholdValue, 12);
  });

  await t.test('update replaces every field, so one the body leaves out goes back to its default', async (t) => {
    const store = fakeStore(t);

    const { result, rows } = await audited(() => notification.update(STAFF, NOTIFICATION_ID, { name: 'Mine', region: '' }));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, false);
    const row = store.written[0];
    assert.strictEqual(row.name, 'Mine');
    assert.strictEqual(row.region, null, "eagle-api's '' default, stored as the mirror stores it");
    assert.strictEqual(row.type, null);
    assert.strictEqual(row.pcp, 'none');
    assert.strictEqual(row.isMet, false);
    assert.strictEqual(row.metURL, '');
    assert.strictEqual(row.dateStarted, null);
    assert.deepStrictEqual(row.centroid, []);
    assert.strictEqual(row.notificationThresholdValue, null);
    assert.deepStrictEqual(row.read, STORED.read, 'PUT leaves the visibility alone');
    assert.strictEqual(row.isPublished, true);
    assert.strictEqual(row.dateAdded, STORED.dateAdded);
    assert.strictEqual(row.updatedBy, 'idir-staff');
    assert.strictEqual(rows[0].Action, 'notification.update');
    assert.deepStrictEqual(rows[0].Detail.fields, ['name', 'region'], 'field names only');
    assert.strictEqual(store.forgotten, 0, 'the read did not move');
  });

  // GET /notifications sorts on it, and Cosmos cannot continue a page from a null sort value.
  await t.test('create without a received date stores the creation time, never null', async (t) => {
    const store = fakeStore(t, null);

    await notification.create(STAFF, { name: 'Quarry', notificationReceivedDate: null });

    const row = store.written[0];
    assert.strictEqual(row.notificationReceivedDate, row.dateAdded);
  });

  await t.test('create keeps a received date the body gives', async (t) => {
    const store = fakeStore(t, null);

    await notification.create(STAFF, { name: 'Quarry', notificationReceivedDate: '2026-05-01T00:00:00.000Z' });

    assert.strictEqual(store.written[0].notificationReceivedDate, '2026-05-01T00:00:00.000Z');
  });

  await t.test('update that omits or nulls the received date falls back to dateAdded', async (t) => {
    for (const body of [{ name: 'Mine' }, { name: 'Mine', notificationReceivedDate: null }]) {
      const store = fakeStore(t, { ...STORED, notificationReceivedDate: '2021-03-01T00:00:00.000Z' });

      const result = await notification.update(STAFF, NOTIFICATION_ID, body);

      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(store.written[0].notificationReceivedDate, STORED.dateAdded, JSON.stringify(body));
      t.mock.restoreAll();
    }
  });

  await t.test('update keeps an isMet of false, as eagle-api does with ??', async (t) => {
    const store = fakeStore(t);
    await audited(() => notification.update(STAFF, NOTIFICATION_ID, { name: 'Mine', isMet: true, pcp: 'closed' }));
    assert.strictEqual(store.written[0].isMet, true);
    assert.strictEqual(store.written[0].pcp, 'closed');
  });

  await t.test('update ignores read and isPublished, and a body of only those is invalid', async (t) => {
    const store = fakeStore(t);
    await audited(() => notification.update(STAFF, NOTIFICATION_ID, { name: 'Mine', read: ['sysadmin'], isPublished: false }));
    assert.deepStrictEqual(store.written[0].read, STORED.read);
    assert.strictEqual(store.written[0].isPublished, true);

    const { result } = await audited(() => notification.update(STAFF, NOTIFICATION_ID, { read: ['sysadmin'] }));
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.body);
    assert.strictEqual(store.written.length, 1);
  });

  await t.test('update refuses to blank a field a vis dial hides from the caller', async (t) => {
    const store = fakeStore(t, { ...STORED, vis: { region: 1 } });
    const { result } = await audited(() => notification.update(STAFF, NOTIFICATION_ID, { name: 'Mine' }));
    assert.strictEqual(result.status, 'invalid');
    assert.deepStrictEqual(result.fields, { region: 'is not writable by this caller' });
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('update of a missing row is not-found and writes nothing', async (t) => {
    const store = fakeStore(t, null);
    const { result, rows } = await audited(() => notification.update(STAFF, NOTIFICATION_ID, { name: 'Mine' }));
    assert.strictEqual(result.status, 'not-found');
    assert.strictEqual(store.written.length, 0);
    assert.strictEqual(rows.length, 0);
  });

  await t.test('publish adds public, sets isPublished, audits and drops the parent cache', async (t) => {
    const store = fakeStore(t, { ...STORED, read: ['staff', 'sysadmin'], isPublished: false });
    const { result, rows } = await audited(() => notification.publish(STAFF, NOTIFICATION_ID));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.written[0].read, ['public', 'staff', 'sysadmin']);
    assert.strictEqual(store.written[0].isPublished, true);
    assert.strictEqual(store.written[0].name, STORED.name, 'publish touches no content field');
    assert.strictEqual(rows[0].Action, 'notification.publish');
    assert.strictEqual(store.forgotten, 1);
  });

  await t.test('unpublish takes public out of the read and clears isPublished', async (t) => {
    const store = fakeStore(t);
    const { result, rows } = await audited(() => notification.unpublish(STAFF, NOTIFICATION_ID));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.written[0].read, ['staff', 'sysadmin']);
    assert.strictEqual(store.written[0].isPublished, false);
    assert.strictEqual(rows[0].Action, 'notification.unpublish');
    assert.strictEqual(store.forgotten, 1);
  });

  await t.test('publish of a missing row is not-found and writes nothing', async (t) => {
    const store = fakeStore(t, null);
    const { result, rows } = await audited(() => notification.publish(STAFF, NOTIFICATION_ID));
    assert.strictEqual(result.status, 'not-found');
    assert.strictEqual(store.written.length, 0);
    assert.strictEqual(rows.length, 0);
    assert.strictEqual(store.forgotten, 0);
  });
});
