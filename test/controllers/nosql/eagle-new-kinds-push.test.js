'use strict';

/**
 * The user, group and inspection mirrors. What is asserted is what stays silent when it breaks,
 * because the push answers 200 either way: the stored ACL a row is gated by, the parent that caps
 * it, the fields a visitor gets back, and the secrets that must never be stored.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../../src/db/cosmos-nosql');
const { levelOfRead } = require('../../../src/helpers/access-sql');
const { redactForAccess } = require('../../../src/vis/redact');
const groups = require('../../../src/repositories/groups');
const userController = require('../../../src/controllers/nosql/user');
const inspectionController = require('../../../src/controllers/nosql/inspection');
const {
  PUBLIC_ACL, PRIVATE_ACL, INSPECTOR_ACL, INSPECTION_EAGLE_ID, ELEMENT_EAGLE_ID, USER_EAGLE_ID,
  storedProject, storedElement, eagleUser, eagleGroup, eagleInspection,
  eagleInspectionElement, eagleInspectionItem, captureMirror, mockRes, anonymous, staff
} = require('../../helpers/eagle-mirror-fixtures');

const STAFF_READ = ['sysadmin', 'staff'];

function anonymousReq(params = {}, query = {}) {
  return { params, query, headers: {} };
}

function staffReq(params = {}, query = {}) {
  return { params, query, headers: {}, user: { realm_access: { roles: ['staff'] } } };
}

test('user mirror', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('create: Eagle `[sysadmin]` stays privileged-only, nothing added', async () => {
    const { res, row } = await captureMirror(t, 'users');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { id: USER_EAGLE_ID, action: 'upsert' });
    assert.deepStrictEqual(row.read, ['sysadmin']);
    assert.strictEqual(row.isPublished, false);
    assert.strictEqual(row.email, 'robin.inspector@example.invalid');
  });

  await t.test('password and salt are stored nowhere, the raw copy included', async () => {
    const { row } = await captureMirror(t, 'users', eagleUser({ password: 'hash-value', salt: 'salt-value' }));
    assert.ok(!('password' in row) && !('salt' in row));
    assert.ok(!('password' in row.sources.eagle) && !('salt' in row.sources.eagle));
  });

  await t.test('update: the stored row is replaced with the new fields', async () => {
    const existing = { id: USER_EAGLE_ID, read: STAFF_READ, email: 'old@example.invalid', _etag: 'e1' };
    const { res, row } = await captureMirror(t, 'users', eagleUser({ email: 'new@example.invalid' }), { existing });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(row.email, 'new@example.invalid');
  });

  await t.test('delete flag: a published user is flagged and narrowed to level 2', async () => {
    const { row } = await captureMirror(t, 'users', eagleUser({ read: PUBLIC_ACL, isDeleted: true }));
    assert.strictEqual(row.isDeleted, true);
    assert.strictEqual(levelOfRead(row.read), 2);
    assert.strictEqual(row.isPublished, false);
  });

  await t.test('anonymous never sees a user email, even on a user row Eagle published', async () => {
    const { row } = await captureMirror(t, 'users', eagleUser({ read: PUBLIC_ACL }));
    assert.ok(row.read.includes('public'), 'the row itself is public, so only the field level hides it');
    t.mock.method(cosmos, 'readItem', async () => row);

    const asAnonymous = mockRes();
    await userController.getUser(anonymousReq({ id: USER_EAGLE_ID }), asAnonymous);
    assert.strictEqual(asAnonymous.statusCode, 200);
    assert.strictEqual(asAnonymous.body.lastName, 'Inspector');
    for (const field of ['email', 'phoneNumber', 'cellPhoneNumber', 'faxNumber', 'address1', 'postalCode']) {
      assert.ok(!(field in asAnonymous.body), `${field} reached an anonymous caller`);
    }

    const asStaff = mockRes();
    await userController.getUser(staffReq({ id: USER_EAGLE_ID }), asStaff);
    assert.strictEqual(asStaff.body.email, 'robin.inspector@example.invalid');
  });

  await t.test('anonymous gets no unpublished user at all', async () => {
    const { row } = await captureMirror(t, 'users');
    t.mock.method(cosmos, 'readItem', async () => row);
    const res = mockRes();
    await userController.getUser(anonymousReq({ id: USER_EAGLE_ID }), res);
    assert.strictEqual(res.statusCode, 404);
  });
});

test('group mirror', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('create: partitioned under the DEMI project, `[sysadmin]` stays privileged-only', async () => {
    const { res, row } = await captureMirror(t, 'groups');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(row.projectId, '207');
    assert.deepStrictEqual(row.read, ['sysadmin']);
    assert.deepStrictEqual(row.members, [USER_EAGLE_ID]);
  });

  await t.test('capped by its project: a public group under a private project is not public', async () => {
    const { row } = await captureMirror(t, 'groups', eagleGroup({ read: PUBLIC_ACL }),
      { project: storedProject(PRIVATE_ACL) });
    assert.ok(!row.read.includes('public'));
    assert.strictEqual(levelOfRead(row.read), 2);
  });

  await t.test('update keeps the row in its partition and replaces it', async () => {
    const removed = t.mock.method(groups, 'deleteById', async () => {});
    const existing = { id: eagleGroup()._id, projectId: '207', read: STAFF_READ, name: 'Old', _etag: 'e1' };
    const { row } = await captureMirror(t, 'groups', eagleGroup({ name: 'New' }), { existing });
    assert.strictEqual(row.name, 'New');
    assert.strictEqual(removed.mock.callCount(), 0, 'nothing to remove when the project is the same');
  });

  await t.test('a group moved to another project is removed from the old partition', async () => {
    const removed = t.mock.method(groups, 'deleteById', async () => {});
    const existing = { id: eagleGroup()._id, projectId: '999', read: STAFF_READ, _etag: 'e1' };
    const { res, row } = await captureMirror(t, 'groups', null, { existing });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(row.projectId, '207');
    assert.deepStrictEqual(removed.mock.calls.map(c => c.arguments), [[eagleGroup()._id, '999']],
      'otherwise the group stays listable under its old project');
  });

  await t.test('delete flag: the removed record is kept, flagged, at level 2', async () => {
    const { res, row } = await captureMirror(t, 'groups', eagleGroup({ read: PUBLIC_ACL, isDeleted: true }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(row.isDeleted, true);
    assert.strictEqual(levelOfRead(row.read), 2);
  });

  await t.test('no stored project: 404, nothing written', async () => {
    t.mock.method(require('../../../src/repositories/projects'), 'readForWriteByEagleId', async () => null);
    t.mock.method(require('../../../src/repositories/notifications'), 'readForWrite', async () => null);
    const { res, row } = await captureMirror(t, 'groups', null, { project: null });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(row, undefined);
  });
});

test('inspection mirror', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('create: `[sysadmin, inspector]` under a public project is stored as Eagle has it', async () => {
    const { res, row } = await captureMirror(t, 'inspections');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(row.read, INSPECTOR_ACL);
    assert.strictEqual(row.inspection, INSPECTION_EAGLE_ID);
    assert.strictEqual(row.projectId, '207');
    assert.strictEqual(row.kind, 'Inspection');
  });

  await t.test('capped by its project: published in Eagle, private project, not public', async () => {
    const { row } = await captureMirror(t, 'inspections', eagleInspection({ read: PUBLIC_ACL }),
      { project: storedProject(PRIVATE_ACL) });
    assert.ok(!row.read.includes('public'));
  });

  await t.test('no project in Eagle: stored with a null project under its own read', async () => {
    const { res, row } = await captureMirror(t, 'inspections',
      eagleInspection({ project: null, customProjectName: 'Unlisted mine' }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(row.projectId, null);
    assert.deepStrictEqual(row.read, INSPECTOR_ACL);
  });

  await t.test('update with a level change re-derives the elements under it', async () => {
    const existing = { id: INSPECTION_EAGLE_ID, inspection: INSPECTION_EAGLE_ID, read: PUBLIC_ACL, _etag: 'e1' };
    const { row, cascades } = await captureMirror(t, 'inspections', null, { existing });
    assert.deepStrictEqual(cascades, [['inspection', INSPECTION_EAGLE_ID, row.read]]);
  });

  await t.test('a move inside level 1 re-derives the elements under it', async () => {
    const existing = { id: INSPECTION_EAGLE_ID, inspection: INSPECTION_EAGLE_ID, read: ['sysadmin'], _etag: 'e1' };
    const { row, cascades } = await captureMirror(t, 'inspections', null, { existing });
    assert.deepStrictEqual(row.read, INSPECTOR_ACL);
    assert.deepStrictEqual(cascades, [['inspection', INSPECTION_EAGLE_ID, row.read]]);
  });

  await t.test('update at the same level cascades nothing', async () => {
    const existing = { id: INSPECTION_EAGLE_ID, inspection: INSPECTION_EAGLE_ID, read: INSPECTOR_ACL, _etag: 'e1' };
    const { res, cascades } = await captureMirror(t, 'inspections', null, { existing });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(cascades, []);
  });

  await t.test('delete flag: flagged and narrowed to level 2', async () => {
    const { row } = await captureMirror(t, 'inspections', eagleInspection({ read: PUBLIC_ACL, isDeleted: true }));
    assert.strictEqual(row.isDeleted, true);
    assert.strictEqual(levelOfRead(row.read), 2);
  });

  await t.test('anonymous gets nothing: not the row by id, not the list', async () => {
    const { row } = await captureMirror(t, 'inspections');
    t.mock.method(cosmos, 'readItem', async () => row);
    const byId = mockRes();
    await inspectionController.getInspection(
      anonymousReq({ id: INSPECTION_EAGLE_ID }, { inspection: INSPECTION_EAGLE_ID }), byId);
    assert.strictEqual(byId.statusCode, 404);

    let spec;
    t.mock.method(cosmos, 'query', async (_c, s) => { spec = s; return { items: [] }; });
    const list = mockRes();
    await inspectionController.getInspections(anonymousReq(), list);
    assert.deepStrictEqual(list.body, []);
    assert.match(spec.query, /ARRAY_CONTAINS/, 'the list carries the row predicate');
    assert.ok(spec.parameters.some(p => p.value === 'Inspection'), 'and only the Inspection kind');
  });

  await t.test('staff reads the inspector email; a visitor would not even on a public row', () => {
    const row = { id: INSPECTION_EAGLE_ID, read: PUBLIC_ACL, email: 'robin.inspector@example.invalid', name: 'Site visit' };
    assert.strictEqual(redactForAccess('inspections', row, staff()).email, 'robin.inspector@example.invalid');
    assert.ok(!('email' in redactForAccess('inspections', row, anonymous())));
  });
});

test('inspection element mirror', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('create: carries its inspection and project, capped by the inspection', async () => {
    const { res, row } = await captureMirror(t, 'inspectionElements',
      eagleInspectionElement({ read: PUBLIC_ACL }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(row.inspection, INSPECTION_EAGLE_ID);
    assert.strictEqual(row.projectId, '207');
    assert.ok(!row.read.includes('public'), 'a public element under a level-2 inspection stays level 2');
    assert.strictEqual(levelOfRead(row.read), 2);
  });

  await t.test('no stored inspection lists it yet: 503 so eagle-api retries, nothing written', async () => {
    const { res, row } = await captureMirror(t, 'inspectionElements', null, { parent: null });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(row, undefined);
  });

  await t.test('a level change re-derives its items', async () => {
    const existing = { id: ELEMENT_EAGLE_ID, inspection: INSPECTION_EAGLE_ID, read: PUBLIC_ACL, _etag: 'e1' };
    const { row, cascades } = await captureMirror(t, 'inspectionElements', null, { existing });
    assert.deepStrictEqual(cascades, [['element', INSPECTION_EAGLE_ID, ELEMENT_EAGLE_ID, row.read]]);
  });

  await t.test('delete flag', async () => {
    const { row } = await captureMirror(t, 'inspectionElements', eagleInspectionElement({ isDeleted: true }));
    assert.strictEqual(row.isDeleted, true);
  });
});

test('inspection item mirror', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('create: carries element, inspection and project from its element', async () => {
    const { res, row } = await captureMirror(t, 'inspectionItems');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(row.element, ELEMENT_EAGLE_ID);
    assert.strictEqual(row.inspection, INSPECTION_EAGLE_ID);
    assert.strictEqual(row.projectId, '207');
  });

  await t.test('capped by its element, not only its inspection', async () => {
    const { row } = await captureMirror(t, 'inspectionItems', eagleInspectionItem({ read: PUBLIC_ACL }),
      { parent: storedElement(['sysadmin']) });
    assert.deepStrictEqual(row.read, ['sysadmin']);
  });

  await t.test('update: replaced in place', async () => {
    const existing = { id: eagleInspectionItem()._id, inspection: INSPECTION_EAGLE_ID, read: INSPECTOR_ACL, _etag: 'e1' };
    const { row, cascades } = await captureMirror(t, 'inspectionItems', eagleInspectionItem({ caption: 'New' }), { existing });
    assert.strictEqual(row.caption, 'New');
    assert.deepStrictEqual(cascades, [], 'an item has nothing under it');
  });

  await t.test('delete flag', async () => {
    const { row } = await captureMirror(t, 'inspectionItems', eagleInspectionItem({ read: PUBLIC_ACL, isDeleted: true }));
    assert.strictEqual(row.isDeleted, true);
    assert.strictEqual(levelOfRead(row.read), 2);
  });

  await t.test('no stored element lists it yet: 503', async () => {
    const { res } = await captureMirror(t, 'inspectionItems', null, { parent: null });
    assert.strictEqual(res.statusCode, 503);
  });

  await t.test('stored-file internals reach staff, not a visitor', () => {
    const row = { id: 'i', read: PUBLIC_ACL, internalURL: 'inspections/photo-1.jpg', caption: 'x' };
    assert.strictEqual(redactForAccess('inspectionItems', row, staff()).internalURL, 'inspections/photo-1.jpg');
    assert.ok(!('internalURL' in redactForAccess('inspectionItems', row, anonymous())));
  });
});
