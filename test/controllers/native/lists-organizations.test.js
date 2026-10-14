'use strict';

// Native reads of the `lists` container's two kinds, through the real handlers and the real
// `nativeKind` repository over a fake Cosmos that holds one fixed container.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const listsController = require('../../../src/controllers/native/lists');
const organizationsController = require('../../../src/controllers/native/organizations');
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
    const orgs = await call(organizationsController.getOrganizations, 'sort=-companyType');
    assert.strictEqual(lists.status, 400);
    assert.match(lists.body.error, /cannot sort on: type/);
    assert.strictEqual(orgs.status, 400);
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
