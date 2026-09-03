'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mapLimit } = require('../../src/utils/worker-pool');

test('mapLimit', async (t) => {
  await t.test('runs every item, bounded by concurrency', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen = [];
    let inFlight = 0, peak = 0;

    const results = await mapLimit(items, 5, async (item) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setImmediate(r));
      seen.push(item);
      inFlight--;
      return item * 2;
    });

    assert.deepStrictEqual(results, items.map(i => i * 2), 'results come back in source order');
    assert.strictEqual(seen.length, 50);
    assert.deepStrictEqual(seen.slice().sort((a, b) => a - b), items);
    assert.ok(peak <= 5, `peak concurrency ${peak} exceeded the limit`);
  });

  await t.test('handles an empty list without hanging', async () => {
    await mapLimit([], 8, async () => assert.fail('should not be called'));
  });

  await t.test('a rejecting worker propagates', async () => {
    // Per-key failures are caught by the caller; a worker that throws anyway must not be
    // silently absorbed into a "done" summary.
    await assert.rejects(() => mapLimit([1], 1, async () => { throw new Error('boom'); }), /boom/);
  });
});

test('an async iterable is consumed by shared runners, bounded by concurrency', async () => {
  async function* rows() {
    for (let i = 0; i < 20; i++) yield i;
  }
  const seen = [];
  let inFlight = 0, peak = 0;

  const results = await mapLimit(rows(), 3, async (row, index) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setImmediate(r));
    seen.push(row);
    inFlight--;
    return index;
  });

  assert.strictEqual(seen.length, 20);
  assert.deepStrictEqual(seen.slice().sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit`);
  assert.deepStrictEqual(results, Array.from({ length: 20 }, (_, i) => i));
});
