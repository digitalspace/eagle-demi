'use strict';

// lists.listOrganizationLabels: the read behind a project pin's label.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const lists = require('../../src/repositories/lists');
const { TIER } = require('../../src/helpers/access-sql');

const ANON = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [], level: 4 };
const ORG_A = '5c1f7a3e9b1d2c0012340001';
const ORG_B = '5c1f7a3e9b1d2c0012340002';

test('lists.listOrganizationLabels', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('selects id, name and province of the named organizations, once each, under the caller\'s read', async (t) => {
    const calls = [];
    const stored = [{ id: ORG_A, name: 'Acme', province: 'BC' }];
    t.mock.method(cosmos, 'query', async (container, spec, options) => {
      calls.push({ container, spec, options });
      return { items: stored };
    });

    const rows = await lists.listOrganizationLabels(ANON, [ORG_A, ORG_B, ORG_A]);

    assert.deepStrictEqual(rows, stored);
    const { container, spec, options } = calls[0];
    assert.strictEqual(container, 'lists');
    assert.deepStrictEqual(options, { partitionKey: 'Organization' });
    assert.match(spec.query, /^SELECT c\.id, c\.name, c\.province FROM c/);
    assert.match(spec.query, /c\.read/, 'the caller\'s visibility predicate is composed');
    const ids = spec.parameters.filter(p => p.name.startsWith('@lid')).map(p => p.value);
    assert.deepStrictEqual(ids, [ORG_A, ORG_B]);
  });

  await t.test('no ids asks nothing', async (t) => {
    t.mock.method(cosmos, 'query', async () => { throw new Error('queried'); });
    assert.deepStrictEqual(await lists.listOrganizationLabels(ANON, []), []);
  });
});
