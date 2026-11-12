'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const updates = require('../../../src/repositories/updates');
const controller = require('../../../src/controllers/nosql/update');
const { UPDATE_EAGLE_ID, eagleUpdate, mockRes, STAFF } = require('../../helpers/eagle-mirror-fixtures');

test('PUT /eagle/updates/:eagleId stores the Updates text fields', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('without bidi or control characters', async () => {
    t.mock.method(updates, 'readForWrite', async () => null);
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });
    const hidden = 'Site\u202e C\u2066 Re\u0001port';

    await controller.upsertFromEagle({
      params: { eagleId: UPDATE_EAGLE_ID },
      query: {},
      body: { doc: eagleUpdate({ headline: hidden, shortHeadline: hidden, summary: hidden }) },
      user: STAFF
    }, mockRes());

    assert.strictEqual(written.headline, 'Site C Report');
    assert.strictEqual(written.shortHeadline, 'Site C Report');
    assert.strictEqual(written.summary, 'Site C Report');
  });

  await t.test('as null when nothing but controls is left', async () => {
    t.mock.method(updates, 'readForWrite', async () => null);
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });
    const controls = '\u0001\u202e';

    await controller.upsertFromEagle({
      params: { eagleId: UPDATE_EAGLE_ID },
      query: {},
      body: { doc: eagleUpdate({ headline: controls, shortHeadline: controls, summary: controls }) },
      user: STAFF
    }, mockRes());

    assert.strictEqual(written.headline, null);
    assert.strictEqual(written.shortHeadline, null);
    assert.strictEqual(written.summary, null);
  });
});
