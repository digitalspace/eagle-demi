'use strict';

// Own file: the stalled read below would otherwise hold the module's queue for every later test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readOriginal } = require('../../src/helpers/pdf-original');
const { classicPdf } = require('./pdf-build');

const plain = classicPdf([
  [1, '<< /Type /Catalog /Pages 2 0 R >>'],
  [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
  [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>']
], '/Size 4 /Root 1 0 R');

test('a range read that never settles fails at the deadline and frees the queue', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = readOriginal(() => new Promise(() => {}), plain.length);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10 * 60 * 1000);
  const outcome = stalled.then(() => 'resolved', (err) => err.message);
  assert.match(await Promise.race([outcome, new Promise(resolve => setImmediate(resolve, 'pending'))]), /timed out/);
  const facts = await readOriginal(async (offset, n) => plain.subarray(offset, offset + n), plain.length);
  assert.equal(facts.error, undefined);
});
