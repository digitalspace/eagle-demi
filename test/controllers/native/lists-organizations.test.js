'use strict';

// Native reads of the `lists` container's two kinds, through the real handlers and the real
// `nativeKind` repository over a fake Cosmos that holds one fixed container.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const listsController = require('../../../src/controllers/native/lists');
const organizationsController = require('../../../src/controllers/native/organizations');
const organizationMirror = require('../../../src/controllers/nosql/organization');
const listsRepo = require('../../../src/repositories/lists');
const { TIER } = require('../../../src/helpers/access-sql');
const cosmos = require('../../../src/db/cosmos-nosql');
const { makeRes } = require('../../../src/http/router');

const STAFF = { realm_access: { roles: ['staff'] } };

const LIST_ROW = { id: 'l1', eagleId: 'l1', kind: 'List', name: 'Pre-Application', type: 'eaoStatus', read: ['public'] };
// `description` and `companyLegal` are level 2 in catalog/lists.js.
const ORG_ROW = {
  id: 'o1', eagleId: 'o1', kind: 'Organization', name: 'Acme Mining', city: 'Victoria',
  description: 'staff note', companyLegal: 'Acme Mining Ltd.', read: ['public']
};
const CONTAINER = [LIST_ROW, ORG_ROW];

/** Fake Cosmos: COUNT answers 3, a point read answers the row of that id and kind, a list read
 * answers the rows of the partition it names. Every query spec is recorded. */
function fakeCosmos(t) {
  const specs = [];
  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    specs.push(spec);
    if (spec.query.includes('COUNT(1)')) return { items: [3] };
    return { items: CONTAINER.filter(row => row.kind === options.partitionKey) };
  });
  t.mock.method(cosmos, 'readItem', async (container, id, kind) =>
    CONTAINER.find(row => row.id === id && row.kind === kind) || null);
  return specs;
}

function param(spec, name) {
  const found = spec.parameters.find(p => p.name === name);
  return found && found.value;
}

async function call(handler, qs, { user, id } = {}) {
  const req = { query: querystring.parse(qs), params: { id }, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

test('native lists and organizations', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a parameter the kind does not declare is refused before any read', async (t) => {
    const specs = fakeCosmos(t);
    // `legislation` is a filter on the search compat path, not on these lists; `type` is a List field.
    const lists = await call(listsController.getLists, 'legislation=2002');
    const orgs = await call(organizationsController.getOrganizations, 'type=eaoStatus');
    assert.strictEqual(lists.status, 400);
    assert.match(lists.body.error, /unknown parameter: legislation/);
    assert.strictEqual(orgs.status, 400);
    assert.match(orgs.body.error, /unknown parameter: type/);
    assert.strictEqual(specs.length, 0);
  });

  await t.test('companyType narrows organizations, in the list read and the count', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(organizationsController.getOrganizations, 'companyType=Indigenous%20Group&count=true');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(specs.length, 2);
    for (const spec of specs) {
      assert.ok(spec.query.includes('c.companyType = @nf0'), spec.query);
      assert.strictEqual(param(spec, '@nf0'), 'Indigenous Group');
      assert.strictEqual(param(spec, '@kind'), 'Organization');
    }
  });

  await t.test('companyType given twice matches either value, in the list read and the count', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(organizationsController.getOrganizations,
      'companyType=Indigenous%20Group&companyType=Proponent%2FCertificate%20Holder&count=true');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(specs.length, 2);
    for (const spec of specs) {
      assert.ok(spec.query.includes('c.companyType IN (@nf0_0, @nf0_1)'), spec.query);
      assert.strictEqual(param(spec, '@nf0_0'), 'Indigenous Group');
      assert.strictEqual(param(spec, '@nf0_1'), 'Proponent/Certificate Holder');
    }
  });

  await t.test('companyType given twice still narrows a q read', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(organizationsController.getOrganizations, 'q=acme&companyType=a&companyType=b');
    assert.strictEqual(res.status, 200);
    assert.ok(specs[0].query.includes('c.companyType IN (@nf0_0, @nf0_1)'), specs[0].query);
    assert.match(specs[0].query, /CONTAINS\(c\.name, @nq, true\)/);
  });

  await t.test('a filter not marked repeatable given twice is refused', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(listsController.getLists, 'type=a&type=b');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'parameter given more than once: type');
    assert.strictEqual(specs.length, 0);
  });

  await t.test('count=true sets x-total-count from a count of the same kind', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(listsController.getLists, 'count=true&type=eaoStatus');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['x-total-count'], '3');
    const count = specs.find(spec => spec.query.includes('COUNT(1)'));
    assert.strictEqual(param(count, '@kind'), 'List');
    assert.strictEqual(param(count, '@nf0'), 'eaoStatus');
  });

  await t.test('no count header unless asked', async (t) => {
    fakeCosmos(t);
    const res = await call(organizationsController.getOrganizations, '');
    assert.strictEqual(res.headers['x-total-count'], undefined);
  });

  await t.test('a sort key off the allow-list is refused', async (t) => {
    fakeCosmos(t);
    const lists = await call(listsController.getLists, 'sort=type');
    const orgs = await call(organizationsController.getOrganizations, 'sort=-city');
    assert.strictEqual(lists.status, 400);
    assert.match(lists.body.error, /cannot sort on: type/);
    assert.strictEqual(orgs.status, 400);
    assert.match(orgs.body.error, /cannot sort on: -city/);
  });

  await t.test('sort=-name orders by name descending', async (t) => {
    const specs = fakeCosmos(t);
    await call(organizationsController.getOrganizations, 'sort=-name');
    assert.match(specs[0].query, /ORDER BY c\.name DESC$/);
  });

  await t.test('with no sort, lists and organizations order by name ascending', async (t) => {
    const specs = fakeCosmos(t);
    const lists = await call(listsController.getLists, 'type=eaoStatus');
    const orgs = await call(organizationsController.getOrganizations, '');
    assert.strictEqual(lists.status, 200);
    assert.strictEqual(orgs.status, 200);
    const reads = specs.filter(spec => !spec.query.includes('COUNT(1)'));
    assert.deepStrictEqual(reads.map(spec => param(spec, '@kind')), ['List', 'Organization']);
    for (const read of reads) assert.match(read.query, /ORDER BY c\.name ASC$/);
  });

  await t.test('q matches name, case-insensitive, within the kind', async (t) => {
    const specs = fakeCosmos(t);
    const res = await call(organizationsController.getOrganizations, 'q=acme');
    assert.strictEqual(res.status, 200);
    assert.match(specs[0].query, /CONTAINS\(c\.name, @nq, true\)/);
    assert.strictEqual(param(specs[0], '@nq'), 'acme');
    assert.strictEqual(param(specs[0], '@kind'), 'Organization');
  });

  await t.test('anonymous by-id read of an organization leaves out its level-2 fields', async (t) => {
    fakeCosmos(t);
    const res = await call(organizationsController.getOrganization, '', { id: 'o1' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, 'Acme Mining');
    assert.strictEqual(res.body.description, undefined);
    assert.strictEqual(res.body.companyLegal, undefined);
  });

  await t.test('staff by-id read of an organization keeps its level-2 fields', async (t) => {
    fakeCosmos(t);
    const res = await call(organizationsController.getOrganization, '', { id: 'o1', user: STAFF });
    assert.strictEqual(res.body.description, 'staff note');
  });

  await t.test('a by-id read answers only its own kind', async (t) => {
    fakeCosmos(t);
    const res = await call(listsController.getList, '', { id: 'o1' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'List not found');
  });

  await t.test('an authenticated response is private, no-store', async (t) => {
    fakeCosmos(t);
    const list = await call(listsController.getLists, '', { user: STAFF });
    const one = await call(organizationsController.getOrganization, '', { id: 'o1', user: STAFF });
    assert.strictEqual(list.headers['cache-control'], 'private, no-store');
    assert.strictEqual(one.headers['cache-control'], 'private, no-store');
  });

  await t.test('an anonymous response sets no cache-control of its own', async (t) => {
    fakeCosmos(t);
    const res = await call(listsController.getLists, '');
    assert.strictEqual(res.headers['cache-control'], undefined);
  });
});

// Sorts over rows the real organization mirror wrote. Cosmos drops a row lacking the ORDER BY field,
// so a row with no companyType or companyLegal stays in only because the mirror stores ''.

const PUSHED = [
  { _id: 'o-acme', name: 'Acme Mining', companyType: 'Proponent/Certificate Holder', companyLegal: 'Acme Mining Ltd.', read: ['public'] },
  { _id: 'o-bare', name: 'Bare Org', read: ['public'] },
  { _id: 'o-nation', name: 'Coast Nation', companyType: 'Indigenous Group', companyLegal: 'Coast Nation Society', read: ['public'] }
];

/** Rows the query admits, ordered as Cosmos orders them: a row lacking the ORDER BY field drops out. */
function admitted(rows, spec) {
  const roles = spec.parameters.filter(p => p.name.startsWith('@role')).map(p => p.value);
  const kept = rows.filter(row => roles.length === 0 || row.read.some(r => roles.includes(r)));
  const [, field, dir] = spec.query.match(/ORDER BY c\.(\w+) (ASC|DESC)/) || [];
  if (!field) return kept;
  return kept.filter(row => row[field] !== undefined)
    .sort((a, b) => a[field].localeCompare(b[field]) * (dir === 'DESC' ? -1 : 1));
}

/** Mirrors `PUSHED` through the real write path into an in-memory container, then serves reads from it. */
async function mirroredStore(t) {
  const rows = [];
  const queries = [];
  t.mock.method(cosmos, 'readItem', async (container, id) => structuredClone(rows.find(row => row.id === id) || null));
  t.mock.method(cosmos, 'create', async (container, item) => {
    rows.push(structuredClone(item));
    return item;
  });
  for (const doc of PUSHED) await organizationMirror.mirrorFromEagle(doc._id, doc);

  t.mock.method(cosmos, 'query', async (container, spec) => {
    queries.push(spec.query);
    const found = admitted(rows, spec);
    return { items: spec.query.includes('COUNT(1)') ? [found.length] : structuredClone(found) };
  });
  return { rows, queries };
}

const ids = body => body.map(row => row.id);

test('organizations sort by companyType and companyLegal', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the mirror stores a missing companyType and companyLegal as empty, not absent', async (t) => {
    const { rows } = await mirroredStore(t);
    const bare = rows.find(row => row.id === 'o-bare');
    assert.strictEqual(bare.companyType, '');
    assert.strictEqual(bare.companyLegal, '');
  });

  await t.test('anonymous sort=companyType keeps the row with no type, first', async (t) => {
    const { queries } = await mirroredStore(t);
    const res = await call(organizationsController.getOrganizations, 'sort=companyType&count=true');
    assert.strictEqual(res.status, 200);
    assert.match(queries[0], /ORDER BY c\.companyType ASC$/);
    assert.deepStrictEqual(ids(res.body), ['o-bare', 'o-nation', 'o-acme']);
    assert.strictEqual(res.headers['x-total-count'], '3');
  });

  await t.test('anonymous sort=companyLegal is refused before any read', async (t) => {
    const { queries } = await mirroredStore(t);
    const res = await call(organizationsController.getOrganizations, 'sort=companyLegal');
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /companyLegal/);
    assert.strictEqual(queries.length, 0);
  });

  await t.test('staff sort=-companyLegal orders by legal name descending, no-name row last', async (t) => {
    const { queries } = await mirroredStore(t);
    const res = await call(organizationsController.getOrganizations, 'sort=-companyLegal&count=true', { user: STAFF });
    assert.strictEqual(res.status, 200);
    assert.match(queries[0], /ORDER BY c\.companyLegal DESC$/);
    assert.deepStrictEqual(ids(res.body), ['o-nation', 'o-acme', 'o-bare']);
    assert.strictEqual(res.headers['x-total-count'], '3');
  });

  await t.test('the search compat read keeps name order for a companyLegal sort', async (t) => {
    // listByKind has no per-field check, so a staff-only key must not reach its ORDER BY.
    const { queries } = await mirroredStore(t);
    const anon = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [], level: 4 };
    await listsRepo.listByKind(listsRepo.KINDS.ORGANIZATION, anon, { sortBy: 'companyLegal' });
    assert.match(queries[0], /ORDER BY c\.name ASC$/);
  });
});
