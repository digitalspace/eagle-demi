'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cosmos = require('../../src/db/cosmos-nosql');
const cache = require('../../src/repositories/cache');

test('cache.put stamps storedAt, id and type on the config container', async (t) => {
  let written;
  t.mock.method(cosmos, 'upsert', async (container, doc) => { written = { container, doc }; return doc; });
  await cache.put('cost-mtd', { body: { total: 1 } });
  assert.equal(written.container, 'config');
  assert.equal(written.doc.id, 'cost-mtd');
  assert.equal(written.doc.type, 'cache');
  assert.ok(Number.isFinite(Date.parse(written.doc.storedAt)), 'storedAt must be an ISO date');
  assert.deepEqual(written.doc.body, { total: 1 });
});
