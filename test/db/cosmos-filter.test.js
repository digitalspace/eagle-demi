'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos');

/**
 * Regression: the query layer used to accept a Cosmos-SQL-ish string and "translate" it by
 * substring matching, silently dropping any predicate it did not recognise. `WHERE
 * c.isPublished = true` became `{}`, so every gated read returned the whole collection.
 *
 * A filter that cannot be honoured must be a loud error, never an unfiltered read.
 */
test('queryContainer refuses SQL-string filters instead of silently ignoring them', async (t) => {
  await t.test('rejects the exact clause that used to be dropped', async () => {
    await assert.rejects(
      () => cosmos.queryContainer('projects', 'c.isPublished = true'),
      /Refusing to query/,
      'a SQL string must throw, not fall through to an unfiltered read'
    );
  });

  await t.test('rejects any other string filter', async () => {
    await assert.rejects(() => cosmos.queryContainer('documents', 'c.name = @name'), TypeError);
  });

  await t.test('rejects array filters', async () => {
    await assert.rejects(() => cosmos.queryContainer('projects', ['isPublished']), TypeError);
  });

  await t.test('countContainer applies the same guard', async () => {
    await assert.rejects(
      () => cosmos.countContainer('records', 'c.isPublished = true'),
      /Refusing to query/,
      'counts must not leak totals for records the caller cannot see'
    );
  });

  await t.test('accepts a plain Mongo filter object', async () => {
    // No DB connection in unit tests: getContainer returns nothing and the call resolves
    // to []. What matters is that it does NOT throw on a valid filter shape.
    await assert.doesNotReject(() => cosmos.queryContainer('projects', { isPublished: true }));
    await assert.doesNotReject(() => cosmos.queryContainer('projects', {}));
    await assert.doesNotReject(() => cosmos.queryContainer('projects'));
  });
});
