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

  await t.test('control and noncharacter entities stay as written', () => {
    const text = '&#1;&#x1F;&#127;&#x80;&#159;&#xFDD0;&#xFDEF;&#xFFFE;&#x1FFFF;&#x10FFFF;';
    assert.strictEqual(decodeEntities(text), text);
  });

  await t.test('tab, line feed, carriage return and their neighbours still decode', () => {
    assert.strictEqual(decodeEntities('&#9;&#10;&#13;&#32;&#160;&#xFDCF;&#xFDF0;&#xFFFD;'),
      '\t\n\r \u00a0\ufdcf\ufdf0\ufffd');
  });
});
