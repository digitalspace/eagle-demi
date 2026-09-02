'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { packParts, packPartCount } = require('../../src/jobs/pack-parts');

const ids = parts => parts.map(part => part.map(doc => doc.id));

test('packParts', async (t) => {
  await t.test('fills a part to the cap before opening the next one', () => {
    const docs = [
      { id: 'a', fileSize: 600 },
      { id: 'b', fileSize: 400 },
      { id: 'c', fileSize: 100 }
    ];
    assert.deepStrictEqual(ids(packParts(docs, 1000)), [['a', 'b'], ['c']]);
  });

  await t.test('keeps the order it was given', () => {
    const docs = [
      { id: 'a', fileSize: 900 },
      { id: 'b', fileSize: 100 },
      { id: 'c', fileSize: 900 }
    ];
    assert.deepStrictEqual(ids(packParts(docs, 1000)), [['a', 'b'], ['c']],
      'the controller and the worker pack the same list, so a reorder here is a partCount that lies');
  });

  await t.test('a document over the cap gets a part to itself rather than a refusal', () => {
    const docs = [
      { id: 'a', fileSize: 100 },
      { id: 'big', fileSize: 5000 },
      { id: 'b', fileSize: 100 }
    ];
    assert.deepStrictEqual(ids(packParts(docs, 1000)), [['a'], ['big'], ['b']]);
  });

  await t.test('an unrecorded size is packed alone, not as zero', () => {
    for (const fileSize of [undefined, null, 0, -1, NaN, 'not a number']) {
      const docs = [{ id: 'a', fileSize: 100 }, { id: 'x', fileSize }, { id: 'b', fileSize: 100 }];
      assert.deepStrictEqual(ids(packParts(docs, 1000)), [['a'], ['x'], ['b']],
        `fileSize ${String(fileSize)} must not be treated as a size that fits`);
    }
  });

  await t.test('no documents is no parts', () => {
    assert.deepStrictEqual(packParts([], 1000), []);
    assert.strictEqual(packPartCount(undefined, 1000), 0);
  });

  await t.test('packPartCount counts what packParts builds', () => {
    const docs = [{ id: 'a', fileSize: 900 }, { id: 'b', fileSize: 900 }];
    assert.strictEqual(packPartCount(docs, 1000), packParts(docs, 1000).length);
  });
});
