'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without a collection rule.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const users = require('../../src/repositories/users');
const { resolveAccess } = require('../../src/helpers/access-sql');
const user = require('../../src/domain/users');

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

const EAO = 'Environmental Assessment Office';
const USER_ID = '5c1f7a3e9b1d2c0012380001';
const ORG_ID = '5c1f7a3e9b1d2c0012370001';
const STORED = Object.freeze({
  id: USER_ID, eagleId: USER_ID, sourceSystem: 'eagle', firstName: 'Ada', middleName: 'K', lastName: 'Lee',
  displayName: 'Ada Lee', email: 'ada@example.ca', org: ORG_ID, orgName: EAO, title: 'Project Lead',
  phoneNumber: '250-555-0100', city: 'Victoria', notes: 'met 2020', isDeleted: false,
  read: ['public', 'staff', 'sysadmin'], isPublished: true, sources: { eagle: { _id: USER_ID } }, _etag: 'e1'
});

function ctxFor(roles, username = 'idir-staff') {
  const req = { user: { sub: 'kc-1', preferred_username: username, realm_access: { roles } }, headers: {} };
  return { access: resolveAccess(req), req };
}
const STAFF = ctxFor(['staff']);

/** Fake storage holding `stored`; returns the rows written. */
function fakeStore(t, stored = STORED) {
  const written = [];
  t.mock.method(users, 'getById', async (access, id) => stored && id === stored.id ? { ...stored } : null);
  t.mock.method(users, 'upsert', async (row) => { written.push(row); return { ...row, _etag: 'e2' }; });
  return written;
}

async function audited(fn) {
  // Drain what an earlier test left batched, so rows hold only this call's events.
  await audit.flush();
  rows = [];
  const result = await fn();
  await audit.flush();
  return { result, rows };
}

test('user domain', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('create stores a staff-only DEMI row with every field defaulted, even for an EAO user', async (t) => {
    const written = fakeStore(t, null);

    const { result, rows } = await audited(() => user.create(STAFF, { firstName: 'Bo', orgName: EAO, org: ORG_ID }));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, true);
    const row = written[0];
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.strictEqual(row.eagleId, null);
    assert.strictEqual(row.firstName, 'Bo');
    assert.strictEqual(row.org, ORG_ID);
    assert.strictEqual(row.lastName, '');
    assert.strictEqual(row.email, '');
    assert.strictEqual(row.middleName, null, 'stored as the mirror stores an empty middleName');
    assert.strictEqual(row.addedBy, 'idir-staff');
    assert.deepStrictEqual(row.read, ['staff', 'sysadmin'], 'eagle-api made an EAO user public; DEMI waits to be asked');
    assert.strictEqual(row.isPublished, false);
    assert.strictEqual(row.write, undefined, 'route guards hold the write rule, not the row');
    assert.strictEqual(row.password, undefined, 'no setPassword: Keycloak holds credentials');
    assert.strictEqual(rows[0].Action, 'user.create', "not eagle-api's 'Put'");
    assert.deepStrictEqual(rows[0].Detail.fields, ['firstName', 'org', 'orgName'], 'field names only');
  });

  await t.test('create with isPublished true makes an EAO user public', async (t) => {
    const written = fakeStore(t, null);
    await audited(() => user.create(STAFF, { orgName: EAO, isPublished: true }));
    assert.deepStrictEqual(written[0].read, ['public', 'staff', 'sysadmin']);
    assert.strictEqual(written[0].isPublished, true);
  });

  await t.test('create refuses isPublished for a user outside EAO, and stores nothing', async (t) => {
    const written = fakeStore(t, null);
    const { result, rows } = await audited(() => user.create(STAFF, { orgName: 'Teck', isPublished: true }));
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.isPublished);
    assert.strictEqual(written.length, 0);
    assert.strictEqual(rows.length, 0);
  });

  await t.test('create ignores a read in the body', async (t) => {
    const written = fakeStore(t, null);
    await audited(() => user.create(STAFF, { orgName: EAO, read: ['public'] }));
    assert.strictEqual(written[0].isPublished, false);
    assert.ok(!written[0].read.includes('public'));
  });

  await t.test('create refuses a password, an unknown key and a bad org, and stores nothing', async (t) => {
    const written = fakeStore(t, null);
    const { result } = await audited(() => user.create(STAFF, { firstName: 'Bo', password: 'x', idirUserGuid: 'y', org: 'Teck' }));
    assert.strictEqual(result.status, 'invalid');
    assert.deepStrictEqual(Object.keys(result.fields).sort(), ['idirUserGuid', 'org', 'password']);
    assert.strictEqual(written.length, 0);
  });

  await t.test('update replaces every field, so one the body leaves out goes back to its default', async (t) => {
    const written = fakeStore(t);

    const { result, rows } = await audited(() => user.update(STAFF, USER_ID, { firstName: 'Ada', orgName: EAO, email: null }));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, false);
    const row = written[0];
    assert.strictEqual(row.firstName, 'Ada');
    assert.strictEqual(row.email, '', "eagle-api's '' for a falsy value");
    assert.strictEqual(row.lastName, '');
    assert.strictEqual(row.phoneNumber, '');
    assert.strictEqual(row.middleName, null);
    assert.strictEqual(row.org, null);
    assert.strictEqual(row.sourceSystem, 'eagle');
    assert.deepStrictEqual(row.sources, STORED.sources, 'the stored Eagle copy is kept');
    assert.deepStrictEqual(row.read, ['public', 'staff', 'sysadmin'], 'an EAO user keeps public when isPublished is left out');
    assert.strictEqual(row.isPublished, true);
    assert.strictEqual(row.updatedBy, 'idir-staff');
    assert.strictEqual(rows[0].Action, 'user.update');
    assert.deepStrictEqual(rows[0].Detail.fields, ['firstName', 'email', 'orgName']);
  });

  await t.test('update that moves a public user off EAO takes public away, as eagle-api does', async (t) => {
    const written = fakeStore(t);
    await audited(() => user.update(STAFF, USER_ID, { firstName: 'Ada', orgName: 'Teck' }));
    assert.deepStrictEqual(written[0].read, ['staff', 'sysadmin']);
    assert.strictEqual(written[0].isPublished, false);
  });

  await t.test('update of a staff-only EAO user stays staff-only unless isPublished is sent', async (t) => {
    const written = fakeStore(t, { ...STORED, read: ['staff', 'sysadmin'], isPublished: false });
    await audited(() => user.update(STAFF, USER_ID, { orgName: EAO }));
    assert.strictEqual(written[0].isPublished, false);

    await audited(() => user.update(STAFF, USER_ID, { orgName: EAO, isPublished: true }));
    assert.deepStrictEqual(written[1].read, ['public', 'staff', 'sysadmin']);
    assert.strictEqual(written[1].isPublished, true);
  });

  await t.test('update with isPublished false unpublishes and keeps other read entries', async (t) => {
    const written = fakeStore(t, { ...STORED, read: ['public', 'sysadmin'] });
    await audited(() => user.update(STAFF, USER_ID, { orgName: EAO, isPublished: false }));
    assert.deepStrictEqual(written[0].read, ['sysadmin']);
    assert.strictEqual(written[0].isPublished, false);
  });

  await t.test('update refuses isPublished outside EAO, and a body of only isPublished or read', async (t) => {
    const written = fakeStore(t);
    const outside = await audited(() => user.update(STAFF, USER_ID, { orgName: 'Teck', isPublished: true }));
    assert.ok(outside.result.fields.isPublished);

    for (const body of [{ isPublished: false }, { read: ['sysadmin'] }]) {
      const { result } = await audited(() => user.update(STAFF, USER_ID, body));
      assert.strictEqual(result.status, 'invalid');
      assert.ok(result.fields.body);
    }
    assert.strictEqual(written.length, 0);
  });

  await t.test('update refuses to blank a field a vis dial hides from the caller', async (t) => {
    const written = fakeStore(t, { ...STORED, vis: { notes: 1 } });
    const { result } = await audited(() => user.update(STAFF, USER_ID, { firstName: 'Ada' }));
    assert.strictEqual(result.status, 'invalid');
    assert.deepStrictEqual(result.fields, { notes: 'is not writable by this caller' });
    assert.strictEqual(written.length, 0);
  });

  await t.test('update of a missing row is not-found and writes nothing', async (t) => {
    const written = fakeStore(t, null);
    const { result, rows } = await audited(() => user.update(STAFF, USER_ID, { firstName: 'Ada' }));
    assert.strictEqual(result.status, 'not-found');
    assert.strictEqual(written.length, 0);
    assert.strictEqual(rows.length, 0);
  });
});
