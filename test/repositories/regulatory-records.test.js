'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const records = require('../../src/repositories/regulatory-records');
const { canRead, TIER } = require('../../src/helpers/access-sql');

const SCOPED_TO_P = { tier: TIER.SCOPED, roles: ['public'], projectScope: ['P'], teams: [] };

test('regulatory records: a credential scoped to P reads no row of Q', async (t) => {
  const query = t.mock.method(cosmos, 'query', async () => ({ items: [] }));

  await records.listByProject(SCOPED_TO_P, 'Q');

  const spec = query.mock.calls[0].arguments[1];
  const scope = spec.parameters.find(p => p.value === 'P');
  assert.ok(scope, 'the scope parameter carries P');
  assert.match(spec.query, new RegExp(`c\\.projectId IN \\(${scope.name}\\)`));
  const row = { id: 'nrpti-1', projectId: 'Q', read: ['public'] };
  assert.strictEqual(canRead(row, SCOPED_TO_P, records.SCOPE_FIELD), false);
});

test('regulatory records: an anonymous list leaves the staff-only upstream reference in Cosmos', async (t) => {
  const query = t.mock.method(cosmos, 'query', async () => ({ items: [] }));

  await records.listByProject({ tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [], level: 4 }, 'P');

  const sql = query.mock.calls[0].arguments[1].query;
  assert.match(sql, /^SELECT VALUE \{ "/, 'an anonymous read projects named fields');
  // Projection goes by maxVis, so `issuedTo` (dial can raise it to 4) still leaves Cosmos.
  assert.ok(!sql.includes('c["source"]'), '`source` has maxVis 2');
});
