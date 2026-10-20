'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without a collection rule.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const groups = require('../../src/repositories/groups');
const projects = require('../../src/repositories/projects');
const { resolveAccess, levelOfRead, canRead } = require('../../src/helpers/access-sql');
const group = require('../../src/domain/groups');

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

const PROJECT_ID = 'p-public';
const PRIVATE_PROJECT_ID = 'p-private';
const GROUP_ID = '5c1f7a3e9b1d2c0012370001';
const USER_A = '5c1f7a3e9b1d2c0012380001';
const USER_B = '5c1f7a3e9b1d2c0012380002';
const USER_C = '5c1f7a3e9b1d2c0012380003';
const PROJECTS = {
  [PROJECT_ID]: { id: PROJECT_ID, read: ['public', 'staff', 'sysadmin'] },
  [PRIVATE_PROJECT_ID]: { id: PRIVATE_PROJECT_ID, read: ['sysadmin'] }
};
const STORED = Object.freeze({
  id: GROUP_ID, eagleId: GROUP_ID, projectId: PROJECT_ID, sourceSystem: 'eagle', name: 'Agencies',
  members: [USER_A, USER_B], links: [], read: ['staff', 'sysadmin'], isPublished: false, _etag: 'e1'
});

function ctxFor(roles, username = 'idir-staff') {
  const req = { user: { sub: 'kc-1', preferred_username: username, realm_access: { roles } }, headers: {} };
  return { access: resolveAccess(req), req };
}
const STAFF = ctxFor(['staff']);

/** Fake storage: one stored group and its projects. Returns what was written and deleted. */
function fakeStore(t, stored = STORED) {
  const store = { written: [], deleted: [] };
  t.mock.method(groups, 'getById', async (access, id) => stored && id === stored.id ? { ...stored } : null);
  t.mock.method(groups, 'upsert', async (row) => { store.written.push(row); return { ...row, _etag: 'e2' }; });
  t.mock.method(groups, 'deleteById', async (...args) => { store.deleted.push(args); return true; });
  // As the repository answers: null for a project the caller may not read.
  t.mock.method(projects, 'getById', async (access, id) =>
    (PROJECTS[id] && canRead(PROJECTS[id], access, projects.PARTITION_FIELD) ? { ...PROJECTS[id] } : null));
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

test('group domain', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('create stores a staff-only DEMI row with no members under the project', async (t) => {
    const store = fakeStore(t, null);

    const { result, rows } = await audited(() => group.create(STAFF, { projectId: PROJECT_ID, name: 'Agencies' }));

    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, true);
    const row = store.written[0];
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.strictEqual(row.projectId, PROJECT_ID);
    assert.strictEqual(row.name, 'Agencies');
    assert.deepStrictEqual(row.members, []);
    assert.strictEqual(row.addedBy, 'idir-staff');
    assert.ok(!row.read.includes('public'), 'a group is never public, even under a public project');
    assert.strictEqual(row.isPublished, false);
    assert.strictEqual(levelOfRead(row.read), 2);
    assert.deepStrictEqual(row.sources.demi.read, group.GROUP_READ);
    assert.strictEqual(row.write, undefined, 'route guards hold the write rule, not the row');
    assert.strictEqual(rows[0].Action, 'group.create');
  });

  await t.test('create under a private project is capped to the project', async (t) => {
    const store = fakeStore(t, null);
    await group.create(ctxFor(['sysadmin']), { projectId: PRIVATE_PROJECT_ID });
    assert.deepStrictEqual(store.written[0].read, ['sysadmin']);
    assert.strictEqual(store.written[0].name, '');
  });

  await t.test('create under a project the caller cannot read answers as an unknown project', async (t) => {
    const store = fakeStore(t, null);
    const hidden = await group.create(STAFF, { projectId: PRIVATE_PROJECT_ID, name: 'x' });
    const missing = await group.create(STAFF, { projectId: 'p-missing', name: 'x' });
    assert.deepStrictEqual(hidden, missing);
    assert.strictEqual(hidden.status, 'invalid');
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('create under a project DEMI does not hold is a 400 on projectId', async (t) => {
    const store = fakeStore(t, null);
    const result = await group.create(STAFF, { projectId: 'p-missing', name: 'x' });
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.projectId);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('create refuses read, members and an unknown key', async (t) => {
    const store = fakeStore(t, null);
    const result = await group.create(STAFF, { projectId: PROJECT_ID, read: ['public'], members: [USER_A] });
    assert.strictEqual(result.status, 'invalid');
    assert.deepStrictEqual(Object.keys(result.fields).sort(), ['members', 'read']);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('update writes the name only and stamps updatedBy', async (t) => {
    const store = fakeStore(t);
    const { result, rows } = await audited(() => group.update(STAFF, GROUP_ID, { name: 'Nations' }));
    assert.strictEqual(result.status, 'ok');
    const row = store.written[0];
    assert.strictEqual(row.name, 'Nations');
    assert.deepStrictEqual(row.members, STORED.members);
    assert.strictEqual(row.projectId, PROJECT_ID);
    assert.strictEqual(row.updatedBy, 'idir-staff');
    assert.strictEqual(rows[0].Action, 'group.update');
  });

  await t.test('update naming anything but name is a 400 and writes nothing', async (t) => {
    const store = fakeStore(t);
    for (const body of [{ members: [USER_C] }, { projectId: PRIVATE_PROJECT_ID }, { read: ['public'] }, {}]) {
      const result = await group.update(STAFF, GROUP_ID, body);
      assert.strictEqual(result.status, 'invalid', JSON.stringify(body));
    }
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('update of a missing group is not-found', async (t) => {
    fakeStore(t, null);
    const result = await group.update(STAFF, GROUP_ID, { name: 'x' });
    assert.strictEqual(result.status, 'not-found');
  });

  await t.test('delete hard-deletes the stored revision', async (t) => {
    const store = fakeStore(t);
    const { result, rows } = await audited(() => group.remove(STAFF, GROUP_ID));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.deleted, [[GROUP_ID, PROJECT_ID, 'e1']]);
    assert.strictEqual(store.written.length, 0);
    assert.strictEqual(rows[0].Action, 'group.delete');
  });

  await t.test('delete of a missing group is not-found', async (t) => {
    const store = fakeStore(t, null);
    const result = await group.remove(STAFF, GROUP_ID);
    assert.strictEqual(result.status, 'not-found');
    assert.strictEqual(store.deleted.length, 0);
  });

  await t.test('adding members appends only ids the group does not hold yet', async (t) => {
    const store = fakeStore(t);
    const { result, rows } = await audited(() =>
      group.addMembers(STAFF, GROUP_ID, { members: [USER_B, USER_C, USER_C] }));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.written[0].members, [USER_A, USER_B, USER_C]);
    assert.strictEqual(rows[0].Action, 'group.addMembers');
  });

  await t.test('adding only held members writes nothing', async (t) => {
    const store = fakeStore(t);
    const result = await group.addMembers(STAFF, GROUP_ID, { members: [USER_A] });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(store.written.length, 0);
  });

  await t.test("eagle-api's bare array body and a malformed id are 400s", async (t) => {
    const store = fakeStore(t);
    assert.strictEqual((await group.addMembers(STAFF, GROUP_ID, [USER_C])).status, 'invalid');
    const bad = await group.addMembers(STAFF, GROUP_ID, { members: ['nope'] });
    assert.ok(bad.fields.members);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('adding members after a lost race keeps the member the other writer added', async (t) => {
    const store = fakeStore(t);
    let raced = false;
    t.mock.method(groups, 'getById', async () => ({ ...STORED, ...(raced && { members: [USER_A, USER_B, USER_C], _etag: 'e9' }) }));
    t.mock.method(groups, 'upsert', async (row) => {
      if (!raced) {
        raced = true;
        throw Object.assign(new Error('precondition'), { code: 412 });
      }
      store.written.push(row);
      return row;
    });
    const result = await group.addMembers(STAFF, GROUP_ID, { members: [USER_C] });
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.written[0].members, [USER_A, USER_B, USER_C]);
  });

  await t.test('removing a member pulls that id only', async (t) => {
    const store = fakeStore(t);
    const { result, rows } = await audited(() => group.removeMember(STAFF, GROUP_ID, USER_A));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(store.written[0].members, [USER_B]);
    assert.strictEqual(rows[0].Action, 'group.removeMember');
  });

  await t.test('removing an id the group does not hold writes nothing', async (t) => {
    const store = fakeStore(t);
    const result = await group.removeMember(STAFF, GROUP_ID, USER_C);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('removing a malformed member id is a 400', async (t) => {
    fakeStore(t);
    const result = await group.removeMember(STAFF, GROUP_ID, 'nope');
    assert.strictEqual(result.status, 'invalid');
    assert.ok(result.fields.userId);
  });
});
