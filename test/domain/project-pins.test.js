'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { resolveAccess } = require('../../src/helpers/access-sql');
const { pinsPublished } = require('../../src/vis/predicates');
const { pinChanges, labelPins, MAX_PINS } = require('../../src/domain/project-pins');
const {
  PUBLISHED_ORG, HIDDEN_ORG, UNKNOWN_ORG, SEALED_ORG, fakeOrgLabels: fakeOrgs
} = require('../helpers/org-labels');

const ctxFor = (roles) => ({ access: resolveAccess({ user: { sub: 'kc-1', realm_access: { roles } }, headers: {} }) });
const STAFF = ctxFor(['staff']);

const UNPUBLISHED_LIST = Object.freeze({ id: 'p1', pins: [], pinsRead: ['staff', 'sysadmin'] });
const PUBLISHED_LIST = Object.freeze({ id: 'p1', pins: [PUBLISHED_ORG], pinsRead: ['public', 'staff', 'sysadmin'] });

test('pinChanges', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a body without pin keys changes nothing and reads nothing', async (t) => {
    const calls = fakeOrgs(t);
    assert.deepStrictEqual(await pinChanges(STAFF, PUBLISHED_LIST, {}), { status: 'ok', changes: {} });
    assert.strictEqual(calls.length, 0);
  });

  await t.test('pins replace the list, de-duplicated in the order sent', async (t) => {
    fakeOrgs(t);
    const result = await pinChanges(STAFF, UNPUBLISHED_LIST, { pins: [HIDDEN_ORG, PUBLISHED_ORG, HIDDEN_ORG] });
    assert.deepStrictEqual(result, { status: 'ok', changes: { pins: [HIDDEN_ORG, PUBLISHED_ORG] } });
  });

  await t.test('the read shape {_id, name, province} is taken as its id', async (t) => {
    fakeOrgs(t);
    const result = await pinChanges(STAFF, UNPUBLISHED_LIST, { pins: [{ _id: PUBLISHED_ORG, name: 'Acme' }] });
    assert.deepStrictEqual(result.changes, { pins: [PUBLISHED_ORG] });
  });

  await t.test('sending back the stored list unchanged needs no pin role', async (t) => {
    const calls = fakeOrgs(t);
    const eagleShaped = { ...PUBLISHED_LIST, pins: [{ _id: PUBLISHED_ORG, name: 'Acme', province: 'BC' }] };
    const result = await pinChanges(ctxFor(['demi-service-write']), eagleShaped,
      { pins: [PUBLISHED_ORG], pinsPublished: true });
    assert.deepStrictEqual(result, { status: 'ok', changes: {} });
    assert.strictEqual(calls.length, 1, 'only the read the caller\'s own GET would make');
  });

  await t.test('a change by a caller without sysadmin, staff or project-system-admin is 403', async (t) => {
    const calls = fakeOrgs(t);
    const result = await pinChanges(ctxFor(['demi-service-write']), UNPUBLISHED_LIST, { pins: [PUBLISHED_ORG] });
    assert.strictEqual(result.status, 'forbidden');
    assert.match(result.error, /sysadmin, staff, project-system-admin/);
    assert.strictEqual(calls.length, 0, 'refused before any organization is looked up');
  });

  await t.test('the id cap counts distinct organizations', async (t) => {
    fakeOrgs(t);
    const result = await pinChanges(STAFF, UNPUBLISHED_LIST, { pins: Array(MAX_PINS + 1).fill(PUBLISHED_ORG) });
    assert.deepStrictEqual(result.changes, { pins: [PUBLISHED_ORG] });
  });

  await t.test('project-system-admin alone may change pins', async (t) => {
    fakeOrgs(t);
    const result = await pinChanges(ctxFor(['project-system-admin']), UNPUBLISHED_LIST, { pins: [PUBLISHED_ORG] });
    assert.strictEqual(result.status, 'ok');
  });

  await t.test('an organization id DEMI does not hold is 400, naming it', async (t) => {
    fakeOrgs(t);
    const result = await pinChanges(STAFF, UNPUBLISHED_LIST, { pins: [PUBLISHED_ORG, UNKNOWN_ORG] });
    assert.deepStrictEqual(result, {
      status: 'invalid', fields: { pins: `unknown organization ids: ${UNKNOWN_ORG}` }
    });
  });

  await t.test('a malformed body is 400 per field', async (t) => {
    fakeOrgs(t);
    for (const body of [{ pins: 'x' }, { pins: ['not-an-id'] }, { pins: [{ name: 'no id' }] },
      { pins: Array.from({ length: MAX_PINS + 1 }, (_, i) => i.toString(16).padStart(24, '0')) }]) {
      const result = await pinChanges(STAFF, UNPUBLISHED_LIST, body);
      assert.strictEqual(result.status, 'invalid', JSON.stringify(body).slice(0, 60));
      assert.ok(result.fields.pins);
    }
    const flag = await pinChanges(STAFF, UNPUBLISHED_LIST, { pinsPublished: 'yes' });
    assert.deepStrictEqual(Object.keys(flag.fields), ['pinsPublished']);
  });

  await t.test('pinning an unpublished organization to an unpublished list is allowed', async (t) => {
    fakeOrgs(t);
    const result = await pinChanges(STAFF, UNPUBLISHED_LIST, { pins: [HIDDEN_ORG] });
    assert.deepStrictEqual(result, { status: 'ok', changes: { pins: [HIDDEN_ORG] } });
  });

  await t.test('publishing a list that holds an unpublished organization is 409, naming it', async (t) => {
    fakeOrgs(t);
    const stored = { ...UNPUBLISHED_LIST, pins: [PUBLISHED_ORG, HIDDEN_ORG] };
    const result = await pinChanges(STAFF, stored, { pinsPublished: true });
    assert.deepStrictEqual(result, { status: 'conflict', error: `Organizations not published: ${HIDDEN_ORG}` });
  });

  await t.test('the 409 counts an unpublished pin the caller cannot see, never naming it', async (t) => {
    fakeOrgs(t);
    const stored = { ...UNPUBLISHED_LIST, pins: [HIDDEN_ORG, SEALED_ORG] };
    const result = await pinChanges(STAFF, stored, { pinsPublished: true });
    assert.deepStrictEqual(result, {
      status: 'conflict',
      error: `Organizations not published: ${HIDDEN_ORG}; 1 organizations you cannot see are not published`
    });
  });

  await t.test('adding an unpublished organization to a published list is 409', async (t) => {
    fakeOrgs(t);
    const result = await pinChanges(STAFF, PUBLISHED_LIST, { pins: [PUBLISHED_ORG, HIDDEN_ORG] });
    assert.strictEqual(result.status, 'conflict');
    assert.match(result.error, new RegExp(HIDDEN_ORG));
  });

  await t.test('a published list holding a since-unpublished organization can still shrink', async (t) => {
    fakeOrgs(t);
    const stored = { ...PUBLISHED_LIST, pins: [PUBLISHED_ORG, HIDDEN_ORG] };
    const result = await pinChanges(STAFF, stored, { pins: [HIDDEN_ORG] });
    assert.deepStrictEqual(result, { status: 'ok', changes: { pins: [HIDDEN_ORG] } });
  });

  await t.test('publish adds public to pinsRead, and the project read then reports pinsPublished', async (t) => {
    fakeOrgs(t);
    const stored = { ...UNPUBLISHED_LIST, pins: [PUBLISHED_ORG] };
    const result = await pinChanges(STAFF, stored, { pinsPublished: true });
    assert.deepStrictEqual(result.changes, { pinsRead: ['public', 'staff', 'sysadmin'] });
    assert.strictEqual(pinsPublished({ ...stored, ...result.changes }), true);
  });

  await t.test('unpublish takes public out of pinsRead, keeping the other entries', async (t) => {
    fakeOrgs(t);
    const stored = { ...PUBLISHED_LIST, pinsRead: ['public', 'project-system-admin'] };
    const result = await pinChanges(STAFF, stored, { pinsPublished: false });
    assert.deepStrictEqual(result.changes, { pinsRead: ['project-system-admin'] });
    assert.strictEqual(pinsPublished({ ...stored, ...result.changes }), false);
  });
});

test('labelPins', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('labels in stored order, ids the caller cannot read dropped', async (t) => {
    const calls = fakeOrgs(t);
    const pins = [HIDDEN_ORG, { _id: UNKNOWN_ORG }, PUBLISHED_ORG];
    const [staffRow] = await labelPins(STAFF.access, [{ pins }]);
    assert.deepStrictEqual(staffRow.pins, [
      { _id: HIDDEN_ORG, name: 'Hidden Co', province: 'AB' },
      { _id: PUBLISHED_ORG, name: 'Acme', province: 'BC' }
    ]);
    const [publicRow] = await labelPins(resolveAccess({}), [{ pins }]);
    assert.deepStrictEqual(publicRow.pins, [{ _id: PUBLISHED_ORG, name: 'Acme', province: 'BC' }]);
    assert.strictEqual(calls.length, 2);
  });

  await t.test('one label read for every row of a page', async (t) => {
    const calls = fakeOrgs(t);
    const rows = await labelPins(STAFF.access, [{ pins: [PUBLISHED_ORG] }, { name: 'no pins' }, { pins: [HIDDEN_ORG] }]);
    assert.deepStrictEqual(rows.map(row => row.pins && row.pins.map(pin => pin._id)),
      [[PUBLISHED_ORG], undefined, [HIDDEN_ORG]]);
    assert.strictEqual(calls.length, 1);
  });

  await t.test('rows with no pins read nothing', async (t) => {
    const calls = fakeOrgs(t);
    assert.deepStrictEqual(await labelPins(STAFF.access, [{}]), [{}]);
    assert.strictEqual(calls.length, 0);
  });
});
