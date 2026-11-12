'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { decodeEntities, plainTextOf, withoutControls } = require('../../src/helpers/html-entities');

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

// U+202E reverses how the text after it reads; U+2066 opens an isolate; U+0001 is no text at all.
const HIDDEN = 'Site\u202e C\u2066 Re\u0001port &#x202E;draft&#x2066;';
const RTL = '\u05e9\u05dc\u05d5\u05dd\u200f (EAO) \u0645\u0631\u062d\u0628\u0627\u061c\u200e';

test('withoutControls', async (t) => {
  await t.test('drops bidi embeddings, overrides and isolates, and C0, DEL and C1 controls', () => {
    const controls = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u0000\u0008\u000b\u001f\u007f\u0080\u009f';
    assert.strictEqual(withoutControls(`a${controls}b`), 'ab');
  });

  await t.test('keeps tab, line feed, carriage return, direction marks and joiners', () => {
    const kept = `a\tb\nc\rd ${RTL} \u200c\u200d`;
    assert.strictEqual(withoutControls(kept), kept);
  });
});

test('plainTextOf', async (t) => {
  await t.test('drops bidi and control characters, raw or written as entities', () => {
    assert.strictEqual(plainTextOf(`<p>${HIDDEN}</p>`), 'Site C Report draft');
  });

  await t.test('keeps the direction marks right-to-left text is written with', () => {
    assert.strictEqual(plainTextOf(`<p>${RTL}</p>`), RTL);
    assert.strictEqual(plainTextOf('\u05e9\u05dc\u05d5\u05dd&#x200F; (EAO)'), '\u05e9\u05dc\u05d5\u05dd\u200f (EAO)');
  });

  await t.test('tabs and line breaks still read as one space', () => {
    assert.strictEqual(plainTextOf('a\tb\r\nc &#9; d'), 'a b c d');
  });
});
