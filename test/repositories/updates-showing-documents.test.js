'use strict';

/**
 * `updates.listShowingDocuments`, the read the Update image cascade releases images by: only an
 * update the public may read keeps an image public.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const updates = require('../../src/repositories/updates');

const DOC = '5c1f7a3e9b1d2c0012370001';

function captured(t) {
  const seen = [];
  t.mock.method(cosmos, 'query', async (container, spec) => { seen.push({ container, spec }); return { items: [] }; });
  return seen;
}

test('listShowingDocuments', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('counts only published updates the public may read', async (t) => {
    const seen = captured(t);
    await updates.listShowingDocuments([DOC]);
    assert.strictEqual(seen[0].container, 'updates');
    assert.match(seen[0].spec.query, /ARRAY_CONTAINS\(c\.read, 'public'\)/);
    assert.match(seen[0].spec.query, /c\.status = @shownStatus/);
  });

  await t.test('looks for the ids in the featured image, the gallery and the attachments', async (t) => {
    const seen = captured(t);
    await updates.listShowingDocuments([DOC]);
    const ids = seen[0].spec.parameters.find(p => p.name === '@shownIds');
    assert.deepStrictEqual(ids.value, [DOC]);
    assert.match(seen[0].spec.query, /c\.featuredImage\.document/);
    assert.match(seen[0].spec.query, /IN c\.images/);
    assert.match(seen[0].spec.query, /IN c\.attachments/);
  });

  await t.test('no ids, no query', async (t) => {
    const seen = captured(t);
    assert.deepStrictEqual(await updates.listShowingDocuments([]), []);
    assert.strictEqual(seen.length, 0);
  });
});
