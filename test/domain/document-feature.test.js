'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { featuresDocument, capRefusal } = require('../../src/domain/document-feature');

test('featuresDocument', async (t) => {
  await t.test('isFeatured true on an unfeatured row features it', () => {
    assert.strictEqual(featuresDocument({ isFeatured: false }, { isFeatured: true }), true);
  });

  await t.test('a row with no isFeatured counts as unfeatured', () => {
    assert.strictEqual(featuresDocument({}, { isFeatured: true }), true);
  });

  await t.test('isFeatured true on a featured row is a re-save, not a feature', () => {
    assert.strictEqual(featuresDocument({ isFeatured: true }, { isFeatured: true }), false);
  });

  await t.test('unfeaturing is never a feature', () => {
    assert.strictEqual(featuresDocument({ isFeatured: true }, { isFeatured: false }), false);
  });

  await t.test('a write that does not name isFeatured is not a feature', () => {
    assert.strictEqual(featuresDocument({}, { displayName: 'Renamed' }), false);
  });
});

test('capRefusal', async (t) => {
  await t.test('below the cap is allowed', () => {
    assert.strictEqual(capRefusal(4, 5), null);
  });

  await t.test('at the cap is refused, naming the limit', () => {
    const refusal = capRefusal(5, 5);
    assert.strictEqual(refusal.limit, 5);
    assert.match(refusal.error, /at most 5 featured documents/);
  });

  await t.test('a cap of 0 refuses every feature', () => {
    assert.strictEqual(capRefusal(0, 0).limit, 0);
  });
});
