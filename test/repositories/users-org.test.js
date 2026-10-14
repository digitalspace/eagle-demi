'use strict';

// users.listByOrg: the read behind an organization rename.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const users = require('../../src/repositories/users');
const { systemAccess, TIER } = require('../../src/helpers/access-sql');

const ORG_ID = '5c1f7a3e9b1d2c0012340001';
const ANON = { tier: TIER.PUBLIC, roles: ['public'], projectScope: null, teams: [], level: 4 };

const param = (spec, name) => (spec.parameters.find(p => p.name === name) || {}).value;

test('users.listByOrg', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('selects the users of one organization, deleted ones left out, across every page', async (t) => {
    const specs = [];
    const pages = [{ items: [{ id: 'u1' }], continuationToken: 'next' }, { items: [{ id: 'u2' }] }];
    t.mock.method(cosmos, 'query', async (container, spec) => { specs.push({ container, spec }); return pages.shift(); });

    const rows = await users.listByOrg(systemAccess(), ORG_ID);

    assert.deepStrictEqual(rows.map(r => r.id), ['u1', 'u2']);
    assert.strictEqual(specs[0].container, 'users');
    assert.match(specs[0].spec.query, /c\.org = @org/);
    assert.strictEqual(param(specs[0].spec, '@org'), ORG_ID);
    assert.match(specs[0].spec.query, /isDeleted/);
  });

  await t.test('composes the caller\'s visibility predicate', async (t) => {
    const specs = [];
    t.mock.method(cosmos, 'query', async (container, spec) => { specs.push(spec); return { items: [] }; });

    await users.listByOrg(ANON, ORG_ID);

    assert.match(specs[0].query, /c\.read/, specs[0].query);
  });
});
