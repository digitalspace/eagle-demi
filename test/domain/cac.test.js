'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without a collection rule.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const projects = require('../../src/repositories/projects');
const notify = require('../../src/services/notify');
const { logger } = require('../../src/utils/logger');
const { resolveAccess } = require('../../src/helpers/access-sql');
const cac = require('../../src/domain/cac');

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

const EAGLE_ID = '5c1f7a3e9b1d2c0012340001';
const PROJECT_ID = `eagle-${EAGLE_ID}`;
const STORED = Object.freeze({
  id: PROJECT_ID, eagleId: EAGLE_ID, read: ['public', 'staff', 'sysadmin'], isPublished: true, name: 'Mine',
  projectCAC: true, projectCACPublished: true, cacEmail: 'cac@example.com', _etag: 'e1'
});

function ctxFor(roles) {
  const req = { user: { sub: 'kc-1', preferred_username: 'idir-staff', realm_access: { roles } }, headers: {} };
  return { access: resolveAccess(req), req };
}
const STAFF = ctxFor(['staff']);

/** Fake storage holding one project; returns the rows written and the options each write passed. */
function fakeStore(t, stored = STORED) {
  const store = { written: [], options: [] };
  t.mock.method(projects, 'getById', async (access, id) => (id === stored.id ? structuredClone(stored) : null));
  t.mock.method(projects, 'upsert', async (row, options) => {
    store.written.push(row);
    store.options.push(options);
    return { ...row, _etag: 'e2' };
  });
  return store;
}

/** Stubs both eagle-notify calls with `answer` (a value or a function returning/throwing); returns the calls. */
function fakeNotify(t, answer) {
  const calls = [];
  const reply = async (...args) => (typeof answer === 'function' ? answer(...args) : answer);
  t.mock.method(notify, 'unsubscribeCac', async (...args) => { calls.push(['cac', ...args]); return reply(...args); });
  t.mock.method(notify, 'unsubscribeCacMember', async (...args) => { calls.push(['member', ...args]); return reply(...args); });
  return calls;
}

const failing = (status, code, configured = true) => () => {
  throw new notify.NotifyError('eagle-notify failed', { status, code, configured });
};

async function audited(fn) {
  // Drain what an earlier test left batched, so rows hold only this call's events.
  await audit.flush();
  rows = [];
  const result = await fn();
  await audit.flush();
  return { result, rows };
}

test('CAC domain', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('get answers the three CAC fields and no member list', async (t) => {
    fakeStore(t);
    const view = await cac.get(STAFF.access, PROJECT_ID);
    assert.deepStrictEqual(
      { projectCAC: view.projectCAC, projectCACPublished: view.projectCACPublished, cacEmail: view.cacEmail },
      { projectCAC: true, projectCACPublished: true, cacEmail: 'cac@example.com' });
    assert.strictEqual(view.cacMembers, undefined);
    assert.strictEqual(view.name, undefined);
    assert.strictEqual(await cac.get(STAFF.access, 'eagle-nope'), null);
  });

  await t.test('create sets the CAC up unpublished with a trimmed email, audited', async (t) => {
    const store = fakeStore(t, { ...STORED, projectCAC: false, projectCACPublished: true, cacEmail: null, _etag: 'e5' });
    const { result, rows } = await audited(() => cac.create(STAFF, PROJECT_ID, { cacEmail: ' new@example.com ' }));
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.created, true);
    const saved = store.written[0];
    assert.deepStrictEqual([saved.projectCAC, saved.projectCACPublished, saved.cacEmail], [true, false, 'new@example.com']);
    assert.deepStrictEqual(store.options, [{ etag: 'e5' }], 'the write is guarded by the etag of the row read');
    assert.strictEqual(rows[0].Action, 'cac.create');
  });

  await t.test('create refuses a missing or malformed email, and writes nothing', async (t) => {
    const store = fakeStore(t);
    assert.deepStrictEqual((await cac.create(STAFF, PROJECT_ID, {})).fields, { cacEmail: 'is required' });
    assert.deepStrictEqual((await cac.create(STAFF, PROJECT_ID, { cacEmail: 'nope' })).fields,
      { cacEmail: 'must be an email address' });
    assert.ok((await cac.create(STAFF, PROJECT_ID, { cacEmail: 'a@b.c', projectCAC: true })).fields.projectCAC);
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('publish and unpublish flip projectCACPublished', async (t) => {
    const store = fakeStore(t, { ...STORED, projectCACPublished: false });
    assert.strictEqual((await cac.publish(STAFF, PROJECT_ID)).value.projectCACPublished, true);
    assert.strictEqual((await cac.unpublish(STAFF, PROJECT_ID)).value.projectCACPublished, false);
    assert.deepStrictEqual(store.written.map(row => row.projectCACPublished), [true, false]);
    assert.deepStrictEqual(store.options, [{ etag: 'e1' }, { etag: 'e1' }], 'each write is guarded by the etag of the row read');
  });

  await t.test('publish refuses a project with no CAC', async (t) => {
    const store = fakeStore(t, { ...STORED, projectCAC: false });
    assert.strictEqual((await cac.publish(STAFF, PROJECT_ID)).status, 'conflict');
    assert.strictEqual(store.written.length, 0);
  });

  await t.test('an unknown project is not-found on every write, with no eagle-notify call', async (t) => {
    fakeStore(t);
    const calls = fakeNotify(t, { count: 0 });
    for (const result of [
      await cac.create(STAFF, 'eagle-nope', { cacEmail: 'a@b.c' }), await cac.publish(STAFF, 'eagle-nope'),
      await cac.unpublish(STAFF, 'eagle-nope'), await cac.remove(STAFF, 'eagle-nope'),
      await cac.removeMember(STAFF, 'eagle-nope', { address: 'a@b.c' })
    ]) assert.strictEqual(result.status, 'not-found');
    assert.deepStrictEqual(calls, []);
  });

  await t.test('delete ends every subscription by Eagle id, then clears and unpublishes the CAC', async (t) => {
    const store = fakeStore(t);
    const calls = fakeNotify(t, { status: 'unsubscribed', count: 4 });
    const { result, rows } = await audited(() => cac.remove(STAFF, PROJECT_ID));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(calls, [['cac', EAGLE_ID]]);
    assert.deepStrictEqual([store.written[0].projectCAC, store.written[0].projectCACPublished], [false, false]);
    assert.strictEqual(store.written[0].cacEmail, 'cac@example.com');
    assert.deepStrictEqual(store.options, [{ etag: 'e1' }], 'the write is guarded by the etag of the row read');
    assert.strictEqual(rows[0].Action, 'cac.delete');
    assert.deepStrictEqual(rows[0].Detail, { membersRemoved: 4 });
  });

  await t.test('delete of a project with no Eagle id writes without calling eagle-notify', async (t) => {
    const store = fakeStore(t, { ...STORED, eagleId: null });
    const calls = fakeNotify(t, failing(500, null));
    assert.strictEqual((await cac.remove(STAFF, PROJECT_ID)).status, 'ok');
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(store.written.length, 1);
  });

  await t.test('an eagle-notify failure on delete leaves the row unchanged and is logged', async (t) => {
    const store = fakeStore(t);
    const errors = [];
    t.mock.method(logger, 'error', (message, meta) => { errors.push({ message, meta }); });
    fakeNotify(t, failing(500, null));
    const { result, rows } = await audited(() => cac.remove(STAFF, PROJECT_ID));
    assert.strictEqual(result.status, 'upstream-failed');
    assert.strictEqual(store.written.length, 0);
    assert.strictEqual(rows.length, 0);
    assert.strictEqual(errors[0].meta.status, 500);
  });

  await t.test('notify not configured fails delete and member removal closed, logged as such', async (t) => {
    const store = fakeStore(t);
    const errors = [];
    t.mock.method(logger, 'error', (message) => { errors.push(message); });
    fakeNotify(t, failing(null, null, false));
    assert.strictEqual((await cac.remove(STAFF, PROJECT_ID)).status, 'unavailable');
    assert.strictEqual((await cac.removeMember(STAFF, PROJECT_ID, { address: 'a@b.c' })).status, 'unavailable');
    assert.strictEqual(store.written.length, 0);
    assert.deepStrictEqual(errors, ['[CAC] notify not configured', '[CAC] notify not configured']);
  });

  await t.test('member removal ends the subscription by Eagle id and trimmed address, audited, no row write', async (t) => {
    const store = fakeStore(t);
    const calls = fakeNotify(t, { status: 'unsubscribed', alreadyUnsubscribed: false });
    const { result, rows } = await audited(() => cac.removeMember(STAFF, PROJECT_ID, { address: ' m@example.com ' }));
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.value.projectCAC, true);
    assert.deepStrictEqual(calls, [['member', EAGLE_ID, 'm@example.com']]);
    assert.strictEqual(store.written.length, 0);
    assert.strictEqual(rows[0].Action, 'cac.member.remove');
    assert.deepStrictEqual(rows[0].Detail, { alreadyRemoved: false });
    assert.doesNotMatch(JSON.stringify(rows[0]), /m@example\.com/, 'the address stays out of the audit row');
  });

  await t.test('an address eagle-notify does not know (404 not_found) counts as removed, logged at info', async (t) => {
    fakeStore(t);
    const infos = [];
    t.mock.method(logger, 'info', (message) => { infos.push(message); });
    fakeNotify(t, failing(404, 'not_found'));
    const { result, rows } = await audited(() => cac.removeMember(STAFF, PROJECT_ID, { address: 'gone@example.com' }));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(rows[0].Detail, { alreadyRemoved: true });
    assert.ok(infos.includes('[CAC] member not subscribed in eagle-notify, treated as removed'));
  });

  await t.test('any other eagle-notify failure fails member removal, unaudited', async (t) => {
    fakeStore(t);
    for (const answer of [failing(400, 'invalid_address'), failing(404, null), failing(null, null)]) {
      fakeNotify(t, answer);
      const { result, rows } = await audited(() => cac.removeMember(STAFF, PROJECT_ID, { address: 'm@example.com' }));
      assert.strictEqual(result.status, 'upstream-failed');
      assert.strictEqual(rows.length, 0);
    }
  });

  await t.test('member removal refuses a malformed address before any call', async (t) => {
    fakeStore(t);
    const calls = fakeNotify(t, { alreadyUnsubscribed: false });
    assert.deepStrictEqual((await cac.removeMember(STAFF, PROJECT_ID, { address: '  ' })).fields,
      { address: 'must be an email address' });
    assert.deepStrictEqual(calls, []);
  });
});
