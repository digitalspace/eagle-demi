'use strict';

/**
 * `projects.listDecisions`, the home feed's project decision read, run against an in-memory
 * container that evaluates the SQL the repository sends: drop the date bound, the dial check, the
 * ORDER BY or the page size and the matching test goes red.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const projects = require('../../src/repositories/projects');
const { resolveAccess, visibilityFor, canRead, TIER } = require('../../src/helpers/access-sql');
const { evaluate } = require('../helpers/updates-store');

const NOW = new Date('2026-10-15T12:00:00.000Z');
const PUBLIC = ['staff', 'idir', 'public'];
const PRIVATE = ['staff'];
const anonymous = () => resolveAccess({});
const STAFF = { tier: TIER.STAFF, roles: ['staff'], projectScope: null, teams: [], level: 2 };

const row = (id, decisionDate, extra = {}) => ({ id, name: id, read: PUBLIC, decisionDate, ...extra });

/**
 * Answer `cosmos.query` over `rows` for `access`. The caller's ACL predicate is answered by its JS
 * twin `canRead`; the rest goes through the shared evaluator, which reads `c.vis["f"]` as a flat key.
 */
function decisionsStore(t, rows, access) {
  const queries = [];
  t.mock.method(cosmos, 'query', async (container, spec, options = {}) => {
    queries.push({ container, spec, options });
    const m = /^SELECT .+? FROM c WHERE (.+?)(?: ORDER BY c\.(\w+) (ASC|DESC))?$/s.exec(spec.query);
    const acl = `(${visibilityFor(access, 'id').clause}) AND `;
    assert.ok(m[1].startsWith(acl), 'the read leads with the caller\'s ACL predicate');
    const rest = m[1].slice(acl.length).replace(/c\.vis\["(\w+)"\]/g, 'c.vis_$1');
    const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
    let matched = rows
      .filter(r => canRead(r, access, 'id'))
      .filter(r => evaluate(rest, { ...r, ...Object.fromEntries(Object.entries(r.vis || {}).map(([k, v]) => [`vis_${k}`, v])) }, params));
    if (m[2]) {
      const sign = m[3] === 'DESC' ? -1 : 1;
      matched = matched.sort((a, b) => (a[m[2]] < b[m[2]] ? -sign : a[m[2]] > b[m[2]] ? sign : 0));
    }
    return { items: matched.slice(0, options.maxItemCount || matched.length), continuationToken: undefined };
  });
  return queries;
}

test('projects.listDecisions', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('leaves out a decision dated after now', async () => {
    decisionsStore(t, [row('past', '2026-10-14T00:00:00.000Z'), row('future', '2026-10-16T00:00:00.000Z')], anonymous());
    const rows = await projects.listDecisions(anonymous(), { limit: 5, now: NOW });
    assert.deepStrictEqual(rows.map(r => r.id), ['past']);
  });

  await t.test('leaves out a project without a decision date', async () => {
    decisionsStore(t, [row('dated', '2026-01-01T00:00:00.000Z'), row('null', null), { id: 'absent', read: PUBLIC }], anonymous());
    const rows = await projects.listDecisions(anonymous(), { limit: 5, now: NOW });
    assert.deepStrictEqual(rows.map(r => r.id), ['dated']);
  });

  await t.test('leaves out an unpublished project for an anonymous caller', async () => {
    decisionsStore(t, [row('public', '2026-01-01T00:00:00.000Z'), row('private', '2026-02-01T00:00:00.000Z', { read: PRIVATE })], anonymous());
    const rows = await projects.listDecisions(anonymous(), { limit: 5, now: NOW });
    assert.deepStrictEqual(rows.map(r => r.id), ['public']);
  });

  await t.test('leaves out a row whose own dial hides decisionDate from the caller', async () => {
    decisionsStore(t, [
      row('open', '2026-01-01T00:00:00.000Z'),
      row('dialled', '2026-02-01T00:00:00.000Z', { vis: { decisionDate: 1 } })
    ], anonymous());
    const rows = await projects.listDecisions(anonymous(), { limit: 5, now: NOW });
    assert.deepStrictEqual(rows.map(r => r.id), ['open']);
  });

  await t.test('a staff caller sees the unpublished project the public cannot', async () => {
    decisionsStore(t, [row('private', '2026-02-01T00:00:00.000Z', { read: PRIVATE })], STAFF);
    const rows = await projects.listDecisions(STAFF, { limit: 5, now: NOW });
    assert.deepStrictEqual(rows.map(r => r.id), ['private']);
  });

  await t.test('answers newest decision first', async () => {
    decisionsStore(t, [
      row('mid', '2025-06-01T00:00:00.000Z'),
      row('new', '2026-09-01T00:00:00.000Z'),
      row('old', '2019-03-01T00:00:00.000Z')
    ], anonymous());
    const rows = await projects.listDecisions(anonymous(), { limit: 5, now: NOW });
    assert.deepStrictEqual(rows.map(r => r.id), ['new', 'mid', 'old']);
  });

  await t.test('answers at most limit rows, the newest ones', async () => {
    decisionsStore(t, ['2021', '2022', '2023', '2024', '2025'].map(y => row(y, `${y}-01-01T00:00:00.000Z`)), anonymous());
    const rows = await projects.listDecisions(anonymous(), { limit: 2, now: NOW });
    assert.deepStrictEqual(rows.map(r => r.id), ['2025', '2024']);
  });
});
