'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const mines = require('../../src/repositories/mines');
const { canRead, TIER } = require('../../src/helpers/access-sql');

const SCOPED_TO_P = { tier: TIER.SCOPED, roles: ['public'], projectScope: ['P'], teams: [] };

test('mines: a credential scoped to P reads no row of Q', async (t) => {
  const query = t.mock.method(cosmos, 'query', async () => ({ items: [] }));

  await mines.listByProject(SCOPED_TO_P, 'Q');

  const spec = query.mock.calls[0].arguments[1];
  const scope = spec.parameters.find(p => p.value === 'P');
  assert.ok(scope, 'the scope parameter carries P');
  assert.match(spec.query, new RegExp(`c\\.projectId IN \\(${scope.name}\\)`));
  assert.strictEqual(canRead({ id: 'g1:Q', projectId: 'Q', read: ['public'] }, SCOPED_TO_P, mines.SCOPE_FIELD), false);
});

test('mines: an anonymous list leaves the staff-only upstream reference in Cosmos', async (t) => {
  const query = t.mock.method(cosmos, 'query', async () => ({ items: [] }));

  await mines.listByProject({ tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [], level: 4 }, 'P');

  const sql = query.mock.calls[0].arguments[1].query;
  assert.match(sql, /^SELECT VALUE \{ "/, 'an anonymous read projects named fields');
  assert.ok(!sql.includes('c["source"]'), '`source` has maxVis 2');
});
