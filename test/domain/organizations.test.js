'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without a collection rule.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const lists = require('../../src/repositories/lists');
const users = require('../../src/repositories/users');
const { logger } = require('../../src/utils/logger');
const { resolveAccess } = require('../../src/helpers/access-sql');
const organization = require('../../src/domain/organizations');

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

const PARENT = '5c1f7a3e9b1d2c0012345678';
const ORG_ID = '5c1f7a3e9b1d2c0012340001';
const STORED = Object.freeze({
  id: ORG_ID, eagleId: ORG_ID, kind: 'Organization', sourceSystem: 'eagle',
  name: 'Acme Mining', city: 'Victoria', read: ['public', 'staff', 'sysadmin'], isPublished: true, _etag: 'e1'
});

function ctxFor(roles, username = 'idir-staff') {
  const req = { user: { sub: 'kc-1', preferred_username: username, realm_access: { roles } }, headers: {} };
  return { access: resolveAccess(req), req };
}
const STAFF = ctxFor(['staff']);

/** Fake `lists` storage: one stored organization, and every row upserted kept in order. */
function fakeLists(t, stored = STORED) {
  const written = [];
  t.mock.method(lists, 'getById', async (access, id, kind) =>
    stored && id === stored.id && kind === 'Organization' ? { ...stored } : null);
  t.mock.method(lists, 'upsert', async (row) => { written.push(row); return { ...row, _etag: 'e2' }; });
  return written;
}

/** Fake `users` storage over `members`; `failIds` throw on write. */
function fakeUsers(t, members, failIds = []) {
  const written = [];
  t.mock.method(users, 'listByOrg', async () => members.map(u => ({ ...u })));
  t.mock.method(users, 'getById', async (access, id) => members.find(u => u.id === id) || null);
  t.mock.method(users, 'upsert', async (row) => {
    if (failIds.includes(row.id)) throw new Error('cosmos down');
    written.push(row);
    return row;
  });
  return written;
}

async function audited(fn) {
  rows = [];
  const result = await fn();
  await audit.flush();
  return { result, rows };
}

test('organization domain', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('create stores a DEMI-owned row with public read and the caller stamped', async (t) => {
    const written = fakeLists(t, null);

    const { result } = await audited(() => organization.create(STAFF, { name: 'New Co', city: 'Nelson' }));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, true);
    const row = written[0];
    assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.strictEqual(row.kind, 'Organization');
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.strictEqual(row.eagleId, null);
    assert.deepStrictEqual(row.read, ['public', 'staff', 'sysadmin']);
    assert.strictEqual(row.isPublished, true);
    assert.strictEqual(row.addedBy, 'idir-staff');
    assert.strictEqual(row.updatedBy, 'idir-staff');
    assert.strictEqual(row.name, 'New Co');
    assert.strictEqual(row.companyLegal, '', 'an omitted field gets the eagle-api default');
    assert.strictEqual(row.parentCompany, null);
  });

  await t.test('create with an empty body is allowed, since eagle-api requires no field', async (t) => {
    const written = fakeLists(t, null);
    const { result } = await audited(() => organization.create(STAFF, {}));
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(written[0].name, '');
  });

  await t.test('create writes exactly one organization.create audit row naming the fields given', async (t) => {
    fakeLists(t, null);
    const { result, rows: written } = await audited(() => organization.create(STAFF, { name: 'New Co' }));
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].Action, 'organization.create');
    assert.strictEqual(written[0].TargetId, result.value.id);
    assert.deepStrictEqual(written[0].Detail.fields, ['name']);
  });

  await t.test('create stores an invalid parentCompany as null without an error', async (t) => {
    const written = fakeLists(t, null);
    const { result } = await audited(() => organization.create(STAFF, { name: 'Sub', parentCompany: 'not-an-id' }));
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(written[0].parentCompany, null);
  });

  await t.test('create keeps a valid parentCompany', async (t) => {
    const written = fakeLists(t, null);
    await audited(() => organization.create(STAFF, { parentCompany: PARENT }));
    assert.strictEqual(written[0].parentCompany, PARENT);
  });

  await t.test('create refuses an unknown key, such as read, and stores nothing', async (t) => {
    const written = fakeLists(t, null);
    const { result, rows: logged } = await audited(() =>
      organization.create(STAFF, { name: 'X', read: ['public'] }));
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.read);
    assert.strictEqual(written.length, 0);
    assert.strictEqual(logged.length, 0);
  });

  await t.test('update merges the allowed fields, stamps the editor and keeps the ACL', async (t) => {
    const written = fakeLists(t);
    const editor = ctxFor(['project-system-admin', 'sysadmin'], 'idir-psa');

    const { result } = await audited(() => organization.update(editor, ORG_ID, { city: 'Nelson' }));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, false);
    assert.strictEqual(written[0].city, 'Nelson');
    assert.strictEqual(written[0].name, 'Acme Mining');
    assert.strictEqual(written[0].updatedBy, 'idir-psa');
    assert.ok(written[0].dateUpdated);
    assert.deepStrictEqual(written[0].read, STORED.read);
  });

  await t.test('update keeps dateAdded, which eagle-api resets', async (t) => {
    const written = fakeLists(t, { ...STORED, dateAdded: '2019-01-02T00:00:00.000Z' });
    await audited(() => organization.update(STAFF, ORG_ID, { city: 'Nelson' }));
    assert.strictEqual(written[0].dateAdded, '2019-01-02T00:00:00.000Z');
  });

  await t.test('update refuses a body that sets dateAdded', async (t) => {
    const written = fakeLists(t);
    const { result } = await audited(() => organization.update(STAFF, ORG_ID, { dateAdded: '2026-01-01' }));
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.dateAdded);
    assert.strictEqual(written.length, 0);
  });

  await t.test('update writes one organization.update audit row with field names only', async (t) => {
    fakeLists(t);
    const { rows: written } = await audited(() => organization.update(STAFF, ORG_ID, { city: 'Nelson' }));
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].Action, 'organization.update');
    assert.strictEqual(written[0].TargetId, ORG_ID);
    assert.deepStrictEqual(written[0].Detail, { fields: ['city'] });
  });

  await t.test('update with an empty body is invalid', async (t) => {
    const written = fakeLists(t);
    const { result } = await audited(() => organization.update(STAFF, ORG_ID, {}));
    assert.strictEqual(result.status, 'invalid');
    assert.strictEqual(written.length, 0);
  });

  await t.test('update refuses an invalid parentCompany', async (t) => {
    const written = fakeLists(t);
    const { result } = await audited(() => organization.update(STAFF, ORG_ID, { parentCompany: 'not-an-id' }));
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.parentCompany);
    assert.strictEqual(written.length, 0);
  });

  await t.test('update refuses a body that sets read', async (t) => {
    const written = fakeLists(t);
    const { result } = await audited(() => organization.update(STAFF, ORG_ID, { read: ['sysadmin'] }));
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.read);
    assert.strictEqual(written.length, 0);
  });

  await t.test('update refuses a field above the caller level and writes nothing', async (t) => {
    const written = fakeLists(t);
    const idir = ctxFor(['idir'], 'idir-reader');

    const { result, rows: logged } = await audited(() =>
      organization.update(idir, ORG_ID, { city: 'Nelson', companyLegal: 'Acme Ltd.' }));

    assert.strictEqual(result.status, 'invalid');
    assert.deepStrictEqual(result.fields, { companyLegal: 'is not writable by this caller' });
    assert.strictEqual(written.length, 0);
    assert.strictEqual(logged.length, 0);
  });

  await t.test('update refuses a field a vis dial on the stored row restricts below the caller', async (t) => {
    const written = fakeLists(t, { ...STORED, vis: { city: 1 } });

    const { result } = await audited(() => organization.update(STAFF, ORG_ID, { city: 'Nelson' }));

    assert.strictEqual(result.status, 'invalid');
    assert.deepStrictEqual(result.fields, { city: 'is not writable by this caller' });
    assert.strictEqual(written.length, 0);
  });

  await t.test('update of a row the caller cannot read is not-found and writes nothing', async (t) => {
    const written = fakeLists(t, null);
    const { result, rows: logged } = await audited(() => organization.update(STAFF, ORG_ID, { city: 'Nelson' }));
    assert.strictEqual(result.status, 'not-found');
    assert.strictEqual(written.length, 0);
    assert.strictEqual(logged.length, 0);
  });

  await t.test('a rename sets orgName on every user of the organization', async (t) => {
    fakeLists(t);
    const written = fakeUsers(t, [
      { id: 'u1', org: ORG_ID, orgName: 'Acme Mining' },
      { id: 'u2', org: ORG_ID, orgName: 'Acme Mining' }
    ]);

    await audited(() => organization.update(STAFF, ORG_ID, { name: 'Acme Resources' }));

    assert.deepStrictEqual(written.map(u => [u.id, u.orgName]),
      [['u1', 'Acme Resources'], ['u2', 'Acme Resources']]);
    assert.strictEqual(users.listByOrg.mock.calls[0].arguments[1], ORG_ID);
  });

  await t.test('an update that keeps the name touches no user already carrying it', async (t) => {
    fakeLists(t);
    const written = fakeUsers(t, [{ id: 'u1', org: ORG_ID, orgName: 'Acme Mining' }]);
    await audited(() => organization.update(STAFF, ORG_ID, { name: 'Acme Mining', city: 'Nelson' }));
    assert.strictEqual(written.length, 0);
  });

  await t.test('an update that keeps the name repairs a user left with a stale orgName', async (t) => {
    fakeLists(t);
    const written = fakeUsers(t, [
      { id: 'u1', org: ORG_ID, orgName: 'Acme Mining' },
      { id: 'u2', org: ORG_ID, orgName: 'Acme Old Name' }
    ]);

    const { result } = await audited(() => organization.update(STAFF, ORG_ID, { city: 'Nelson' }));

    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(written.map(u => [u.id, u.orgName]), [['u2', 'Acme Mining']]);
  });

  await t.test('an update of a nameless organization leaves its users alone', async (t) => {
    fakeLists(t, { ...STORED, name: undefined });
    const written = fakeUsers(t, [{ id: 'u1', org: ORG_ID, orgName: 'Acme Mining' }]);
    await audited(() => organization.update(STAFF, ORG_ID, { city: 'Nelson' }));
    assert.strictEqual(written.length, 0);
  });

  await t.test('a user write that fails is logged and the update still succeeds', async (t) => {
    fakeLists(t);
    const written = fakeUsers(t, [
      { id: 'u1', org: ORG_ID, orgName: 'Acme Mining' },
      { id: 'u2', org: ORG_ID, orgName: 'Acme Mining' }
    ], ['u1']);
    const warned = [];
    const counted = [];
    t.mock.method(logger, 'warn', (message, meta) => { warned.push(meta); });
    t.mock.method(logger, 'info', (message, meta) => { counted.push(meta); });

    const { result } = await audited(() => organization.update(STAFF, ORG_ID, { name: 'Acme Resources' }));

    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(written.map(u => u.id), ['u2']);
    assert.strictEqual(warned.length, 1);
    assert.strictEqual(warned[0].userId, 'u1');
    assert.strictEqual(warned[0].orgId, ORG_ID);
    assert.deepStrictEqual(counted.find(meta => meta && 'failed' in meta), { orgId: ORG_ID, updated: 1, failed: 1 });
  });

  await t.test('a user list read that fails is logged and the update still succeeds', async (t) => {
    const written = fakeLists(t);
    const userWrites = fakeUsers(t, [{ id: 'u1', org: ORG_ID, orgName: 'Acme Mining' }]);
    t.mock.method(users, 'listByOrg', async () => { throw new Error('cosmos down'); });
    const warned = [];
    t.mock.method(logger, 'warn', (message, meta) => { warned.push(meta); });

    const { result } = await audited(() => organization.update(STAFF, ORG_ID, { name: 'Acme Resources' }));

    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(written.map(row => row.name), ['Acme Resources']);
    assert.strictEqual(userWrites.length, 0);
    assert.strictEqual(warned.length, 1);
    assert.strictEqual(warned[0].orgId, ORG_ID);
    assert.strictEqual(warned[0].error, 'cosmos down');
  });
});
