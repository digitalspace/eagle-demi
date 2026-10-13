'use strict';

// GET /users and /groups on the native list contract, through the real controllers and
// repositories over a fake Cosmos that applies the role predicate the query carries, so what an
// anonymous caller may see is observed in the response.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

// First: the logger's uncaughtException handler would swallow a load failure here into a green run.
const userController = require('../../../src/controllers/nosql/user');
const groupController = require('../../../src/controllers/nosql/group');
const cosmos = require('../../../src/db/cosmos-nosql');
const audit = require('../../../src/utils/audit');
const projects = require('../../../src/repositories/projects');
const { makeRes } = require('../../../src/http/router');
const { recordEvents } = require('../../helpers/record-events');

const STAFF = { realm_access: { roles: ['staff'] } };

const STAFF_READ = ['sysadmin', 'staff'];

const USERS = [
  { id: 'u1', read: STAFF_READ, displayName: 'Robin Staff', email: 'robin@example.invalid' },
  { id: 'u2', read: ['public'], displayName: 'Sam Public', email: 'sam@example.invalid' }
];
const GROUPS = [
  { id: 'g1', projectId: 'p1', read: ['public'], name: 'Working group', members: ['u1'] },
  { id: 'g2', projectId: 'p1', read: STAFF_READ, name: 'Staff group', members: ['u2'] }
];
const ROWS = { users: USERS, groups: GROUPS };

const paramsOf = spec => spec.parameters || [];

/** Rows whose `read[]` meets the query's `@roleN` parameters; no role parameter reads every row. */
function readable(rows, spec) {
  const roles = paramsOf(spec).filter(p => /^@role\d+$/.test(p.name)).map(p => p.value);
  return roles.length ? rows.filter(row => row.read.some(role => roles.includes(role))) : rows;
}

function fakeCosmos(t) {
  const specs = [];
  t.mock.method(cosmos, 'query', async (container, spec) => {
    // Any other container (the parent project join) holds nothing unless a test mocks it.
    if (!ROWS[container]) return { items: [] };
    specs.push(spec);
    const rows = readable(ROWS[container], spec);
    if (spec.query.includes('COUNT(1)')) return { items: [rows.length] };
    const id = paramsOf(spec).find(p => p.name === '@id');
    return { items: id ? rows.filter(row => row.id === id.value) : rows };
  });
  t.mock.method(cosmos, 'readItem', async (container, id) => ROWS[container].find(row => row.id === id) || null);
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

  await t.test('sort takes displayName and nothing else', async (t) => {
    const specs = fakeCosmos(t);
    const off = await call(list, 'sort=email', { user: STAFF });
    assert.strictEqual(off.status, 400);
    assert.match(off.body.error, /cannot sort on: email/);
    assert.strictEqual((await call(list, 'sort=-displayName', { user: STAFF })).status, 200);
    assert.ok(listQuery(specs).query.endsWith('ORDER BY c.displayName DESC'));
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

  await t.test('group reads are not audited', async (t) => {
    fakeCosmos(t);
    const events = recordEvents(t);
    await call(list, '', { user: STAFF });
    assert.deepStrictEqual(await events(audit.AUDIT_STREAM), []);
  });
});
