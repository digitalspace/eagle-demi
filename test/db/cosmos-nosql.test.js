'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');

// The previous data layer accepted a Cosmos-SQL-shaped string and "translated" it by
// substring matching, silently discarding any predicate it did not recognise — so
// `WHERE c.isPublished = true` became `{}` and every gated read served the whole collection.
// These tests pin the replacement behaviour: anything that cannot be run as a parameterised
// query THROWS. An unrunnable query must never degrade into an unfiltered read.

test('assertQuerySpec rejects everything that is not a parameterised spec', async (t) => {
  const bad = [
    ['a SQL string', 'SELECT * FROM c'],
    ['the exact clause that used to be dropped', 'c.isPublished = true'],
    ['a Mongo filter object', { isPublished: true }],
    ['a Mongo $or filter', { $or: [{ read: { $in: ['public'] } }] }],
    ['an array', ['isPublished']],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['spec with no query', { parameters: [] }],
    ['spec with an empty query', { query: '   ', parameters: [] }],
    ['spec with no parameters array', { query: 'SELECT * FROM c' }],
    ['spec with parameters as an object', { query: 'SELECT * FROM c', parameters: {} }]
  ];

  for (const [label, value] of bad) {
    await t.test(`rejects ${label}`, () => {
      assert.throws(
        () => cosmos.assertQuerySpec(value, 'projects'),
        /Refusing to query/,
        `${label} must throw, not fall through to an unfiltered read`
      );
    });
  }

  await t.test('rejects a parameter whose name is missing the @ sigil', () => {
    assert.throws(() => cosmos.assertQuerySpec(
      { query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: 'id', value: '1' }] },
      'projects'
    ), /beginning with "@"/);
  });

  await t.test('accepts a well-formed spec', () => {
    const spec = {
      query: 'SELECT * FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: '207' }]
    };
    assert.strictEqual(cosmos.assertQuerySpec(spec, 'projects'), spec);
  });

  await t.test('accepts a spec with no parameters', () => {
    const spec = { query: 'SELECT VALUE COUNT(1) FROM c', parameters: [] };
    assert.doesNotThrow(() => cosmos.assertQuerySpec(spec, 'projects'));
  });
});

test('query() validates before touching the database', async (t) => {
  // No COSMOS_ENDPOINT is configured in tests, so getContainer() yields null and a valid spec
  // resolves to an empty result. The point is that validation happens FIRST: a bad spec
  // throws even when there is no connection to fail against.
  await t.test('throws on a bad spec even with no connection', async () => {
    await assert.rejects(
      () => cosmos.query('projects', 'c.isPublished = true'),
      /Refusing to query/
    );
  });

  await t.test('a valid spec resolves to an empty page when unconfigured', async () => {
    const res = await cosmos.query('projects', {
      query: 'SELECT * FROM c',
      parameters: []
    });
    assert.deepStrictEqual(res.items, []);
  });
});

test('patch() guards the Cosmos operation limit', async (t) => {
  await t.test('rejects an empty operation list', async () => {
    await assert.rejects(() => cosmos.patch('projects', '1', '1', []), /non-empty/);
  });

  await t.test('rejects more than 10 operations', async () => {
    const ops = Array.from({ length: 11 }, (_, i) => ({
      op: 'set', path: `/f${i}`, value: i
    }));
    await assert.rejects(() => cosmos.patch('projects', '1', '1', ops), /at most 10/);
  });
});

test('unconfigured client degrades safely rather than throwing', async (t) => {
  await t.test('getDatabase returns null without COSMOS_ENDPOINT', () => {
    assert.strictEqual(cosmos.getDatabase(), null);
  });

  await t.test('readItem returns null', async () => {
    assert.strictEqual(await cosmos.readItem('projects', '207', '207'), null);
  });

  await t.test('ping reports false', async () => {
    assert.strictEqual(await cosmos.ping(), false);
  });
});
