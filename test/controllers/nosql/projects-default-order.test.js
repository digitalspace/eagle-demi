'use strict';

// `GET /projects` with no `sort=` orders by name, so a row whose own dial hides its name from the
// caller must not be listed or counted: its place in the order would show where the name sits.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

const projectController = require('../../../src/controllers/nosql/project');
const cosmos = require('../../../src/db/cosmos-nosql');
const { makeRes } = require('../../../src/http/router');
const { fakeWhereQuery } = require('../../helpers/updates-store');

const STAFF = { realm_access: { roles: ['staff'] } };

const ROWS = [
  { id: 'open', name: 'Alpha', projectType: 'Mines', read: ['public'] },
  { id: 'dialled', name: 'Bravo', projectType: 'Energy', read: ['public'], vis: { name: 2 } },
  { id: 'plain', name: 'Charlie', projectType: 'Water', read: ['public'], vis: { region: 2 } }
];

/** `fakeWhereQuery` over ROWS, with `COUNT(1)` answered as the length of the same match. */
function fakeProjects(t) {
  fakeWhereQuery(t, ROWS);
  const rowsOf = cosmos.query;
  t.mock.method(cosmos, 'query', async (container, spec, options) => {
    if (!spec.query.startsWith('SELECT VALUE COUNT(1) ')) return rowsOf(container, spec, options);
    const { items } = await rowsOf(container, { ...spec, query: spec.query.replace('VALUE COUNT(1)', '*') }, options);
    return { items: [items.length] };
  });
}

async function call(qs, user) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined, user };
  const res = makeRes('test');
  await projectController.getProjects(req, res);
  return { status: res.statusCode, headers: res.headers, ids: JSON.parse(res.body).map(row => row.id) };
}

test('GET /projects default name order honours each row\'s name dial', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an anonymous caller gets neither the row nor a count of it', async (t) => {
    fakeProjects(t);
    const res = await call('count=true');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.ids, ['open', 'plain']);
    assert.strictEqual(res.headers['x-total-count'], '2');
  });

  await t.test('a caller at the dial\'s level gets it in name order', async (t) => {
    fakeProjects(t);
    const res = await call('count=true', STAFF);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.ids, ['open', 'dialled', 'plain']);
    assert.strictEqual(res.headers['x-total-count'], '3');
  });

  await t.test('an explicit sort on another field lists and counts the row for an anonymous caller', async (t) => {
    fakeProjects(t);
    const res = await call('sort=projectType&count=true');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.ids, ['dialled', 'open', 'plain']);
    assert.strictEqual(res.headers['x-total-count'], '3');
  });
});
