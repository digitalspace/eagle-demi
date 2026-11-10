'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { decodeEntities } = require('../../src/helpers/html-entities');

test('decodeEntities', async (t) => {
  await t.test('a name only Object.prototype knows stays as written', () => {
    const text = 'a &constructor; &Constructor; &toString; b';
    assert.strictEqual(decodeEntities(text), text);
  });

  await t.test('NUL and lone surrogate entities stay as written', () => {
    assert.strictEqual(decodeEntities('a&#0;b'), 'a&#0;b');
    assert.strictEqual(decodeEntities('&#xD800;&#56320;'), '&#xD800;&#56320;');
  });
});
