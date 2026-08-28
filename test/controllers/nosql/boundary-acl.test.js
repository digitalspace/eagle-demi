'use strict';

/**
 * The ACL a written boundary carries. P3-2 converts the write site to `readForLevel` at the level
 * it already meant, so no stored row's visibility moves.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const boundaries = require('../../../src/repositories/boundaries');
const boundaryController = require('../../../src/controllers/nosql/boundary');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
}

test('a written boundary carries the ladder tokens for its level', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  async function create(isPublished) {
    let saved;
    t.mock.method(boundaries, 'upsert', async (doc) => { saved = doc; return doc; });

    await boundaryController.createBoundary({
      body: { type: 'Municipality', name: 'Fort St. John', isPublished }
    }, mockRes());

    return saved;
  }

  await t.test('a new unpublished boundary still reads as level 2 after P3-2', async () => {
    const saved = await create(false);

    assert.deepStrictEqual(saved.read, ['staff'], 'the level the legacy ACL already meant');
    assert.strictEqual(saved.isPublished, false);
  });

  await t.test('a published boundary reads as level 4', async () => {
    // Reference geography defaults to published, which is what all 281 stored rows are.
    const saved = await create(undefined);

    assert.deepStrictEqual(saved.read, ['staff', 'idir', 'public']);
    assert.strictEqual(saved.isPublished, true);
  });
});
