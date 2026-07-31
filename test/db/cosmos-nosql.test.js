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

// The defect this pins took demi-api-dev fully unreachable for ~6 minutes: a ranked query that
// matched nothing against a NON-EMPTY container left hasMoreResults() permanently true, so
// fetchAll() spun on a single core. The process never exited, so there was no crash, no restart
// and nothing in the logs — only an app that stopped answering. The page cap is what converts
// that hang into a visible short result.
test('drainRanked bounds the drain instead of spinning', async (t) => {
  function iter(pages) {
    let i = 0;
    return {
      hasMoreResults: () => true, // the pathological case: never goes false
      fetchNext: async () => {
        const page = pages[Math.min(i, pages.length - 1)];
        i++;
        return { resources: page, requestCharge: 1 };
      }
    };
  }

  await t.test('a never-terminating iterator stops at the page cap', async () => {
    const res = await cosmos.drainRanked(iter([[]]), 20);
    assert.deepStrictEqual(res.items, []);
    assert.strictEqual(res.pages, cosmos.RANKED_MAX_PAGES, 'must stop at the cap, not loop');
    assert.strictEqual(res.truncated, true, 'hitting the cap must be reported, not silent');
  });

  await t.test('empty early pages are drained rather than read once', async () => {
    // The opposite failure: one fetchNext() returns nothing for a query that HAS matches.
    const res = await cosmos.drainRanked(iter([[], [], [{ id: 'a' }, { id: 'b' }]]), 2);
    assert.deepStrictEqual(res.items.map(i => i.id), ['a', 'b']);
    assert.strictEqual(res.truncated, false);
  });

  await t.test('stops as soon as top is satisfied', async () => {
    const res = await cosmos.drainRanked(iter([[{ id: 'a' }, { id: 'b' }, { id: 'c' }]]), 2);
    assert.strictEqual(res.items.length, 2, 'must not exceed top');
    assert.strictEqual(res.pages, 1);
  });

  // The page cap is not a bound on TIME. 50 pages that each take seconds is minutes, and a
  // request that runs for minutes on a single-worker plan takes every other endpoint with it.
  await t.test('a past deadline stops the drain and reports timedOut', async () => {
    const res = await cosmos.drainRanked(iter([[]]), 20, { deadline: Date.now() - 1 });
    assert.strictEqual(res.pages, 0, 'must not issue a page once the deadline has passed');
    assert.strictEqual(res.timedOut, true);
    assert.strictEqual(res.truncated, true, 'a timeout must also read as truncated');
  });

  await t.test('a live deadline does not interfere with a normal drain', async () => {
    const res = await cosmos.drainRanked(iter([[{ id: 'a' }]]), 1, { deadline: Date.now() + 60000 });
    assert.deepStrictEqual(res.items.map(i => i.id), ['a']);
    assert.strictEqual(res.timedOut, false);
    assert.strictEqual(res.truncated, false);
  });

  await t.test('queryRanked still validates the spec', async () => {
    await assert.rejects(() => cosmos.queryRanked('chunks_fts', 'SELECT *', { top: 5 }), TypeError);
  });
});
