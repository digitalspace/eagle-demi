'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { stripInternals, INTERNAL_FIELDS } = require('../../src/db/cosmos-nosql');

test('Cosmos system fields do not escape the data layer', async (t) => {
  await t.test('internals are removed', () => {
    // _self and _rid disclose the internal resource path; _attachments and _ts are noise. On
    // 60,578 documents they are dead weight in every response.
    const item = {
      id: '1', name: 'X',
      _rid: 'abc', _self: 'dbs/x/colls/y/docs/z', _attachments: 'attachments/', _ts: 1
    };
    const out = stripInternals(item);
    for (const f of INTERNAL_FIELDS) assert.ok(!(f in out), `${f} leaked`);
    assert.strictEqual(out.id, '1');
    assert.strictEqual(out.name, 'X');
  });

  await t.test('_etag is KEPT — it is the concurrency token replace() needs', () => {
    // Removing it would quietly make safe concurrent writes impossible.
    assert.strictEqual(stripInternals({ id: '1', _etag: '"0x8D"' })._etag, '"0x8D"');
    assert.ok(!INTERNAL_FIELDS.includes('_etag'));
  });

  await t.test('non-objects pass through untouched', () => {
    assert.strictEqual(stripInternals(null), null);
    assert.strictEqual(stripInternals(undefined), undefined);
    assert.strictEqual(stripInternals(42), 42);
  });
});
