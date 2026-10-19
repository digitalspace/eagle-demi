'use strict';

// GET /users and /groups on the native list contract, through the real controllers and
// repositories over a fake Cosmos that applies the role predicate the query carries, so what an
// anonymous caller may see is observed in the response.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const userController = require('../../../src/controllers/nosql/user');
const groupController = require('../../../src/controllers/nosql/group');
const cosmos = require('../../../src/db/cosmos-nosql');
const audit = require('../../../src/utils/audit');
const projects = require('../../../src/repositories/projects');
const { NOT_DELETED } = require('../../../src/repositories/_sql');
const { makeRes } = require('../../../src/http/router');
const { recordEvents } = require('../../helpers/record-events');
const { swaggerParams } = require('../../helpers/swagger-params');

const STAFF = { realm_access: { roles: ['staff'] } };
const SYSADMIN = { realm_access: { roles: ['sysadmin'] } };

const STAFF_READ = ['sysadmin', 'staff'];

const USERS = [
  { id: 'u1', read: STAFF_READ, displayName: 'Robin Staff', email: 'robin@example.invalid' },
  { id: 'u2', read: ['public'], displayName: 'Sam Public', email: 'sam@example.invalid' },
  // Pushed by eagle-api with `isDeleted: true`: the mirror keeps it at staff, no read serves it.
  { id: 'u3', read: STAFF_READ, displayName: 'Robin Gone', email: 'gone@example.invalid', isDeleted: true }
];
const GROUPS = [
  { id: 'g1', projectId: 'p1', read: ['public'], name: 'Working group', members: ['u1'] },
  { id: 'g2', projectId: 'p1', read: STAFF_READ, name: 'Staff group', members: ['u2'] },
  { id: 'g3', projectId: 'p1', read: STAFF_READ, name: 'Working group (deleted)', members: [], isDeleted: true }
];
const ROWS = { users: USERS, groups: GROUPS };

const paramsOf = spec => spec.parameters || [];

/**
 * Rows whose `read[]` meets the query's `@roleN` parameters (none reads every row), less the
 * deleted ones when the query carries `NOT_DELETED`.
 */
function readable(rows, spec) {
  const roles = paramsOf(spec).filter(p => /^@role\d+$/.test(p.name)).map(p => p.value);
  const live = spec.query.includes(NOT_DELETED.clause) ? rows.filter(row => row.isDeleted !== true) : rows;
  return roles.length ? live.filter(row => row.read.some(role => roles.includes(role))) : live;
}

/** Cosmos ORDER BY on one key: a row lacking the field drops out. */
function ordered(rows, spec) {
  const [, field, dir] = spec.query.match(/ORDER BY c\.(\w+) (ASC|DESC)$/) || [];
  if (!field) return rows;
  return rows.filter(row => row[field] !== undefined)
    .sort((a, b) => a[field].localeCompare(b[field]) * (dir === 'DESC' ? -1 : 1));
}

function fakeCosmos(t, store = ROWS) {
  const specs = [];
  t.mock.method(cosmos, 'query', async (container, spec) => {
    // Any other container (the parent project join) holds nothing unless a test mocks it.
    if (!store[container]) return { items: [] };
    specs.push(spec);
    const rows = readable(store[container], spec);
    if (spec.query.includes('COUNT(1)')) return { items: [rows.length] };
    const id = paramsOf(spec).find(p => p.name === '@id');
    return { items: id ? rows.filter(row => row.id === id.value) : ordered(rows, spec) };
  });
  t.mock.method(cosmos, 'queryFirst', async (container, spec) => {
    if (!store[container]) return null;
    specs.push(spec);
    const id = paramsOf(spec).find(p => p.name === '@id');
    return readable(store[container], spec).find(row => row.id === id.value) || null;
  });
  t.mock.method(cosmos, 'readItem', async (container, id) => store[container].find(row => row.id === id) || null);
  return specs;
}

function listQuery(specs) {
  const lists = specs.filter(spec => !spec.query.includes('COUNT(1)'));
  assert.strictEqual(lists.length, 1, 'expected one list read');
  return lists[0];
}

function param(spec, name) {
  const found = paramsOf(spec).find(p => p.name === name);
  return found && found.value;
}

async function call(handler, qs, { user, id } = {}) {
  const req = { query: querystring.parse(qs), params: { id }, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test('native users read', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const { getUsers: list, getUser: get } = userController;

  await t.test('an anonymous list holds no staff-only user and no contact field', async (t) => {
    fakeCosmos(t);
    const res = await call(list, '');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(row => row.id), ['u2']);
    assert.strictEqual(res.body[0].email, undefined);
  });

  await t.test('an anonymous q is refused before any read: it would search email', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'q=sam');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot filter on a field this caller cannot see: email/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('staff q searches displayName and email', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'q=robin', { user: STAFF });
    assert.strictEqual(res.status, 200);
    const read = listQuery(specs);
    assert.ok(read.query.includes('CONTAINS(c.displayName, @nq, true)'), read.query);
    assert.ok(read.query.includes('CONTAINS(c.email, @nq, true)'), read.query);
    assert.strictEqual(param(read, '@nq'), 'robin');
    assert.strictEqual(res.body.find(row => row.id === 'u1').email, 'robin@example.invalid');
  });

  await t.test('staff ids= reads the named ids through an IN clause', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(list, 'ids=u1,u2', { user: STAFF })).status, 200);
    const read = listQuery(specs);
    assert.ok(read.query.includes('c.id IN (@nid0, @nid1)'), read.query);
    assert.deepStrictEqual([param(read, '@nid0'), param(read, '@nid1')], ['u1', 'u2']);
  });

  await t.test('a sort key off the list is refused before any read', async (t) => {
    const specs = fakeCosmos(t);
    const off = await call(list, 'sort=city', { user: STAFF });
    assert.strictEqual(off.status, 400);
    assert.match(off.body.error, /cannot sort on: city/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('sort=-displayName orders by displayName descending', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(list, 'sort=-displayName', { user: STAFF })).status, 200);
    assert.ok(listQuery(specs).query.endsWith('ORDER BY c.displayName DESC'));
  });

  await t.test('swagger offers each sort key both ways, and no other', () => {
    const offered = swaggerParams('/api/users').get('sort').match(/enum: \[([^\]]*)\]/)[1].split(/,\s*/);
    const keys = userController.nativeSpec.sortKeys;
    assert.deepStrictEqual(offered.sort(), keys.flatMap(key => [key, `-${key}`]).sort());
  });

  await t.test('count=true sets x-total-count from the same predicate', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, 'count=true', { user: STAFF })).headers['x-total-count'], '2');
    assert.strictEqual((await call(list, 'count=true')).headers['x-total-count'], '1');
  });

  await t.test('a continuation token is no longer a parameter', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, 'continuationToken=abc')).status, 400);
  });

  await t.test('staff list and by-id reads are audited; anonymous ones are not', async (t) => {
    fakeCosmos(t);
    const events = recordEvents(t);

    await call(list, '');
    await call(get, '', { id: 'u2' });
    await call(list, 'ids=u1', { user: STAFF });
    await call(get, '', { id: 'u1', user: STAFF });

    const rows = await events(audit.AUDIT_STREAM);
    assert.deepStrictEqual(rows.map(row => [row.Action, row.TargetType, row.TargetId || null]),
      [['users.list', 'users', null], ['users.read', 'users', 'u1']]);
  });

  await t.test('a staff q on users writes no analytics search event', async (t) => {
    fakeCosmos(t);
    const events = recordEvents(t);
    assert.strictEqual((await call(list, 'q=robin', { user: STAFF })).status, 200);
    assert.deepStrictEqual(await events(audit.EVENTS_STREAM), []);
  });

  await t.test('a deleted user is in no list and no count, staff or sysadmin', async (t) => {
    fakeCosmos(t);
    for (const user of [STAFF, SYSADMIN]) {
      const listed = await call(list, 'count=true', { user });
      assert.deepStrictEqual(listed.body.map(row => row.id).sort(), ['u1', 'u2']);
      assert.strictEqual(listed.headers['x-total-count'], '2');
      // The fake does not apply CONTAINS, so q is checked for the deleted row and the count only.
      const searched = await call(list, 'q=robin&count=true', { user });
      assert.ok(!searched.body.some(row => row.id === 'u3'));
      assert.strictEqual(searched.headers['x-total-count'], String(searched.body.length));
    }
  });

  await t.test('by id: a deleted user is a 404 to every caller', async (t) => {
    fakeCosmos(t);
    for (const user of [undefined, STAFF, SYSADMIN]) {
      assert.strictEqual((await call(get, '', { id: 'u3', user })).status, 404);
    }
  });

  await t.test('by id: a staff-only user is a 404 to an anonymous caller, whole to staff', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(get, '', { id: 'u1' })).status, 404);
    const staff = await call(get, '', { id: 'u1', user: STAFF });
    assert.strictEqual(staff.body.email, 'robin@example.invalid');
    assert.strictEqual(staff.headers['cache-control'], 'private, no-store');
  });
});

test('native groups read', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const { getGroups: list, getGroup: get } = groupController;

  await t.test('project= narrows the list read on projectId', async (t) => {
    const specs = fakeCosmos(t);
    assert.strictEqual((await call(list, 'project=p1')).status, 200);
    const read = listQuery(specs);
    assert.ok(read.query.includes('c.projectId = @nf0'), read.query);
    assert.strictEqual(param(read, '@nf0'), 'p1');
  });

  await t.test('projectId= is not a second spelling of project=', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(list, 'projectId=p1');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /unknown parameter: projectId/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('an anonymous list holds no staff-only group and no members', async (t) => {
    fakeCosmos(t);
    const res = await call(list, '');
    assert.deepStrictEqual(res.body.map(row => row.id), ['g1']);
    assert.strictEqual(res.body[0].members, undefined);
  });

  await t.test('q searches name, and the term reaches analytics', async (t) => {
    const specs = fakeCosmos(t);
    const events = recordEvents(t);
    assert.strictEqual((await call(list, 'q=working')).status, 200);
    assert.ok(listQuery(specs).query.includes('CONTAINS(c.name, @nq, true)'));
    const searches = await events(audit.EVENTS_STREAM);
    assert.deepStrictEqual(searches.map(row => [row.EventName, row.SearchTerm, row.Detail.kind]),
      [['search', 'working', 'groups']]);
  });

  await t.test('sort takes name and nothing else', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(list, 'sort=members', { user: STAFF })).status, 400);
    assert.strictEqual((await call(list, 'sort=name')).status, 200);
  });

  await t.test('swagger offers each sort key both ways, and no other', () => {
    const offered = swaggerParams('/api/groups').get('sort').match(/enum: \[([^\]]*)\]/)[1].split(/,\s*/);
    const keys = groupController.nativeSpec.sortKeys;
    assert.deepStrictEqual(offered.sort(), keys.flatMap(key => [key, `-${key}`]).sort());
  });

  await t.test('rows carry the parent project name and Eagle id', async (t) => {
    fakeCosmos(t);
    t.mock.method(projects, 'listRowsByIds', async () => [
      { id: 'p1', read: ['public'], name: 'Site C', eagleId: '5c1a2b3c4d5e6f7a8b9c0d1e' }
    ]);
    const listed = await call(list, 'project=p1');
    assert.strictEqual(listed.body[0].projectName, 'Site C');
    const one = await call(get, '', { id: 'g1' });
    assert.strictEqual(one.body.projectEagleId, '5c1a2b3c4d5e6f7a8b9c0d1e');
  });

  await t.test('by id takes no query parameter', async (t) => {
    fakeCosmos(t);
    assert.strictEqual((await call(get, 'project=p1', { id: 'g1' })).status, 400);
  });

  await t.test('a deleted group is in no list and no count, staff or sysadmin', async (t) => {
    fakeCosmos(t);
    for (const user of [STAFF, SYSADMIN]) {
      const listed = await call(list, 'project=p1&count=true', { user });
      assert.deepStrictEqual(listed.body.map(row => row.id).sort(), ['g1', 'g2']);
      assert.strictEqual(listed.headers['x-total-count'], '2');
      // The fake does not apply CONTAINS, so q is checked for the deleted row and the count only.
      const searched = await call(list, 'q=working&count=true', { user });
      assert.ok(!searched.body.some(row => row.id === 'g3'));
      assert.strictEqual(searched.headers['x-total-count'], String(searched.body.length));
    }
  });

  await t.test('by id: a deleted group is a 404 to every caller', async (t) => {
    fakeCosmos(t);
    for (const user of [undefined, STAFF, SYSADMIN]) {
      assert.strictEqual((await call(get, '', { id: 'g3', user })).status, 404);
    }
  });

  await t.test('group reads are not audited', async (t) => {
    fakeCosmos(t);
    const events = recordEvents(t);
    await call(list, '', { user: STAFF });
    assert.deepStrictEqual(await events(audit.AUDIT_STREAM), []);
  });
});

// Sorts over rows the real user mirror wrote. Cosmos drops a row lacking the ORDER BY field, so a
// user pushed with no orgName or phoneNumber stays in only because the mirror stores ''.

const PUSHED = [
  { _id: 'u-ann', read: ['public'], displayName: 'Ann', orgName: 'Zeta Corp', email: 'ann@example.invalid', phoneNumber: '250-555-0101' },
  { _id: 'u-bo', read: ['public'], displayName: 'Bo', email: 'bo@example.invalid' },
  { _id: 'u-cy', read: ['public'], displayName: 'Cy', orgName: 'Acme', email: 'cy@example.invalid', phoneNumber: '250-555-0199' }
];

/** Mirrors `PUSHED` through the real write path into an in-memory container; returns the read specs after. */
async function mirroredUsers(t) {
  const users = [];
  t.mock.method(cosmos, 'create', async (container, item) => {
    users.push(structuredClone(item));
    return item;
  });
  const specs = fakeCosmos(t, { users });
  for (const doc of PUSHED) await userController.mirrorFromEagle(doc._id, doc);
  specs.length = 0;
  return specs;
}

const ids = body => body.map(row => row.id);

test('users sort by orgName, email and phoneNumber', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const { getUsers: list } = userController;

  await t.test('anonymous sort=orgName keeps the user with no organization, first', async (t) => {
    const specs = await mirroredUsers(t);
    const res = await call(list, 'sort=orgName&count=true');
    assert.strictEqual(res.status, 200);
    assert.ok(listQuery(specs).query.endsWith('ORDER BY c.orgName ASC'));
    assert.deepStrictEqual(ids(res.body), ['u-bo', 'u-cy', 'u-ann']);
    assert.strictEqual(res.headers['x-total-count'], '3');
  });

  await t.test('anonymous sort=email is refused before any read', async (t) => {
    const specs = await mirroredUsers(t);
    const res = await call(list, 'sort=email');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot see: email$/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('anonymous sort=-phoneNumber is refused before any read', async (t) => {
    const specs = await mirroredUsers(t);
    const res = await call(list, 'sort=-phoneNumber');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot see: phoneNumber$/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('staff sort=-email orders by email descending', async (t) => {
    const specs = await mirroredUsers(t);
    const res = await call(list, 'sort=-email', { user: STAFF });
    assert.strictEqual(res.status, 200);
    assert.ok(listQuery(specs).query.endsWith('ORDER BY c.email DESC'));
    assert.deepStrictEqual(ids(res.body), ['u-cy', 'u-bo', 'u-ann']);
  });

  await t.test('staff sort=phoneNumber keeps the user with no phone, first', async (t) => {
    const specs = await mirroredUsers(t);
    const res = await call(list, 'sort=phoneNumber&count=true', { user: STAFF });
    assert.strictEqual(res.status, 200);
    assert.ok(listQuery(specs).query.endsWith('ORDER BY c.phoneNumber ASC'));
    assert.deepStrictEqual(ids(res.body), ['u-bo', 'u-ann', 'u-cy']);
    assert.strictEqual(res.headers['x-total-count'], '3');
  });
});
