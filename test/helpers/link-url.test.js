'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { validateDestination } = require('../../src/helpers/link-url');

const ALLOWED = ['gov.bc.ca'];

test('validateDestination', async (t) => {
  await t.test('an allowlisted https url is accepted', () => {
    const result = validateDestination('https://projects.eao.gov.bc.ca/p/123', ALLOWED);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.url, 'https://projects.eao.gov.bc.ca/p/123');
  });

  await t.test('a host off the allowlist is rejected', () => {
    const result = validateDestination('https://evil.example.com', ALLOWED);
    assert.strictEqual(result.ok, false);
  });

  await t.test('a host that merely ends in the allowlisted string, without a dot boundary, is rejected', () => {
    const result = validateDestination('https://evilgov.bc.ca', ALLOWED);
    assert.strictEqual(result.ok, false);
  });

  await t.test('http is rejected even on an allowlisted host', () => {
    const result = validateDestination('http://projects.eao.gov.bc.ca', ALLOWED);
    assert.strictEqual(result.ok, false);
  });

  await t.test('credentials embedded in the url are rejected', () => {
    const result = validateDestination('https://user:pass@projects.eao.gov.bc.ca', ALLOWED);
    assert.strictEqual(result.ok, false);
  });

  await t.test('an over-length url and a non-url string are both rejected', () => {
    const oversized = `https://projects.eao.gov.bc.ca/${'a'.repeat(2049)}`;
    assert.strictEqual(validateDestination(oversized, ALLOWED).ok, false);
    assert.strictEqual(validateDestination('not a url', ALLOWED).ok, false);
  });
});
