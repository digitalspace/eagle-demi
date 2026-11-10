'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { metUrlKey } = require('../../src/helpers/met-url');

test('metUrlKey', async (t) => {
  await t.test('ignores the scheme, the host and a trailing slash', () => {
    assert.strictEqual(metUrlKey('https://engage.eao.gov.bc.ca/nicomen-wind'), '/nicomen-wind');
    assert.strictEqual(metUrlKey('http://test.engage.eao.gov.bc.ca/nicomen-wind/'), '/nicomen-wind');
  });

  await t.test('keeps a query, so two queries on one path stay apart', () => {
    assert.strictEqual(metUrlKey('https://engage.eao.gov.bc.ca/view?id=7'), '/view?id=7');
    assert.notStrictEqual(metUrlKey('https://a.gov.bc.ca/view?id=7'), metUrlKey('https://b.gov.bc.ca/view?id=8'));
  });

  await t.test('ignores a fragment', () => {
    assert.strictEqual(metUrlKey('https://engage.eao.gov.bc.ca/nicomen-wind#comments'), '/nicomen-wind');
  });

  await t.test('a URL with no scheme compares by its path', () => {
    assert.strictEqual(metUrlKey('engage.eao.gov.bc.ca/nicomen-wind'), '/nicomen-wind');
  });

  await t.test('is null when no path is left to compare', () => {
    assert.strictEqual(metUrlKey('https://engage.eao.gov.bc.ca/'), null);
    assert.strictEqual(metUrlKey(''), null);
    assert.strictEqual(metUrlKey(undefined), null);
  });
});
