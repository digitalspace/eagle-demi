'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const { firstByIdAcross } = require('../../src/repositories/_first-by-id');
const { NOT_DELETED } = require('../../src/repositories/_sql');
const { TIER } = require('../../src/helpers/access-sql');

const ANON = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [] };

test('firstByIdAcross matches the id after the caller criteria, under the access predicate', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  let container, spec, options;
  t.mock.method(cosmos, 'queryFirst', async (c, s, o) => {
    container = c; spec = s; options = o;
    return { id: '42' };
  });

  const row = await firstByIdAcross('commentPeriods', ANON, 'projectId', 42, [NOT_DELETED]);

  assert.deepStrictEqual(row, { id: '42' });
  assert.strictEqual(container, 'commentPeriods');
  assert.deepStrictEqual(options, {});
  assert.ok(spec.query.indexOf(NOT_DELETED.clause) < spec.query.indexOf('c.id = @id'), spec.query);
  assert.ok(spec.query.endsWith('(c.id = @id)'), spec.query);
  assert.ok(spec.parameters.some(p => p.name === '@id' && p.value === '42'));
  assert.ok(spec.parameters.some(p => p.value === 'public'), 'the caller access must reach the query');
});
