'use strict';

// `GET /notifications?sort=subType` over rows the real mirror wrote. Cosmos drops a row lacking the
// ORDER BY field, so the sort keeps a row with no sub-type only because the mirror stores it as null.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const querystring = require('node:querystring');

// First: the logger's uncaughtException handler would swallow a load failure here into a green run.
const notificationsController = require('../../../src/controllers/native/notifications');
const notificationMirror = require('../../../src/controllers/nosql/notification');
const cosmos = require('../../../src/db/cosmos-nosql');
const aiSearch = require('../../../src/search/ai-search');
const { makeRes } = require('../../../src/http/router');

const PUSHED = [
  { _id: 'n-mine', name: 'Mine notice', type: 'Mines', subType: 'Coal', read: ['public'], notificationReceivedDate: '2026-03-01T00:00:00.000Z' },
  { _id: 'n-none', name: 'Pipeline notice', type: 'Industrial', read: ['public'], notificationReceivedDate: '2026-02-01T00:00:00.000Z' },
  { _id: 'n-dam', name: 'Dam notice', type: 'Water', subType: 'Hydro', read: ['public'], notificationReceivedDate: '2026-01-01T00:00:00.000Z' }
];

const param = (spec, name) => spec.parameters.find(p => p.name === name).value;

/** Rows the query admits, ordered as Cosmos orders them: a row lacking the field drops out, null sorts first. */
function admitted(rows, spec) {
  const roles = spec.parameters.filter(p => p.name.startsWith('@role')).map(p => p.value);
  const idList = spec.query.match(/c\.id IN \(([@\w, ]+)\)/);
  const ids = idList && idList[1].split(', ').map(name => param(spec, name));
  const kept = rows
    .filter(row => roles.length === 0 || row.read.some(r => roles.includes(r)))
    .filter(row => !ids || ids.includes(row.id));
  const [, field, dir] = spec.query.match(/ORDER BY c\.(\w+) (ASC|DESC)/) || [];
  if (!field) return kept;
  const key = row => (row[field] === null ? '' : `~${row[field]}`);
  return kept.filter(row => row[field] !== undefined)
    .sort((a, b) => key(a).localeCompare(key(b)) * (dir === 'DESC' ? -1 : 1));
}

/** Mirrors `PUSHED` through the real write path into an in-memory container, then serves reads from it. */
async function mirroredStore(t, { ranked = [] } = {}) {
  const rows = [];
  const queries = [];
  t.mock.method(cosmos, 'readItem', async (container, id) => structuredClone(rows.find(row => row.id === id) || null));
  t.mock.method(cosmos, 'create', async (container, item) => {
    rows.push(structuredClone(item));
    return item;
  });
  for (const doc of PUSHED) await notificationMirror.mirrorFromEagle(doc._id, doc);

  t.mock.method(cosmos, 'query', async (container, spec, opts = {}) => {
    queries.push(spec.query);
    const found = admitted(rows, spec);
    if (spec.query.includes('COUNT(1)')) return { items: [found.length] };
    return { items: structuredClone(found.slice(0, opts.maxItemCount || found.length)) };
  });
  t.mock.method(aiSearch, 'searchNotifications', async () => ({ count: ranked.length, items: ranked.map(id => ({ id })) }));
  return { rows, queries };
}

async function list(qs) {
  const req = { query: querystring.parse(qs), params: {}, headers: {}, header: () => undefined };
  const res = makeRes('test');
  await notificationsController.getNotifications(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}

const ids = body => body.map(row => row.id);

test('notifications sort by sub-type', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the mirror stores a missing sub-type as null, not absent', async (t) => {
    const { rows } = await mirroredStore(t);
    assert.strictEqual(rows.find(row => row.id === 'n-none').subType, null);
  });

  await t.test('sort=subType keeps the row with no sub-type, first', async (t) => {
    const { queries } = await mirroredStore(t);
    const res = await list('sort=subType&count=true');
    assert.strictEqual(res.status, 200);
    assert.match(queries[0], /ORDER BY c\.subType ASC/);
    assert.deepStrictEqual(ids(res.body), ['n-none', 'n-mine', 'n-dam']);
    assert.strictEqual(res.headers['x-total-count'], '3');
  });

  await t.test('sort=-subType puts the row with no sub-type last', async (t) => {
    await mirroredStore(t);
    const res = await list('sort=-subType');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(ids(res.body), ['n-dam', 'n-mine', 'n-none']);
  });

  await t.test('the q path re-reads the ranked ids in sub-type order', async (t) => {
    await mirroredStore(t, { ranked: ['n-dam', 'n-none'] });
    const res = await list('q=notice&sort=subType');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(ids(res.body), ['n-none', 'n-dam']);
  });
});
