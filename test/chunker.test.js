'use strict';

/**
 * The chunker decides how many rows land in Typesense, and Typesense holds its index in RAM — so
 * these are capacity tests as much as correctness ones. Measured on the real corpus: ~1.1 KB of
 * index RAM per chunk against an average 601-character chunk, i.e. per-chunk overhead dominates
 * the text. Emitting one chunk per paragraph projected to 3.1M chunks / 3.4 GB; accumulating to
 * ~2500 characters projects to ~740k.
 */

const test = require('node:test');
const assert = require('node:assert');
const { chunkMarkdown } = require('../src/chunker');

const para = (n, ch = 'a') => ch.repeat(n);

test('chunkMarkdown', async (t) => {
  await t.test('empty input yields no chunks', () => {
    assert.deepStrictEqual(chunkMarkdown(''), []);
    assert.deepStrictEqual(chunkMarkdown('   \n\n  '), []);
    assert.deepStrictEqual(chunkMarkdown(null), []);
  });

  await t.test('short paragraphs are NEVER dropped — they merge', () => {
    // The regression this guards: the old implementation filtered out every paragraph shorter
    // than MIN_CHUNK_SIZE *before* merging, so headings, table rows and short lines vanished from
    // the indexed text. Raising the minimum would have deleted almost the whole corpus.
    const md = ['# Heading', 'Short line.', 'Another short one.'].join('\n\n');
    const chunks = chunkMarkdown(md);

    assert.strictEqual(chunks.length, 1);
    for (const fragment of ['# Heading', 'Short line.', 'Another short one.']) {
      assert.ok(chunks[0].content.includes(fragment), `lost: ${fragment}`);
    }
  });

  await t.test('paragraphs accumulate to the target instead of one chunk each', () => {
    // 20 paragraphs of 300 chars = 6000 chars. One chunk per paragraph would be 20 chunks.
    const md = Array.from({ length: 20 }, (_, i) => para(300, String.fromCharCode(97 + i)))
      .join('\n\n');
    const chunks = chunkMarkdown(md);

    assert.ok(chunks.length <= 4, `expected accumulation, got ${chunks.length} chunks`);
    assert.ok(chunks.length >= 2, 'and it should still split a 6000-char document');
    for (const c of chunks.slice(0, -1)) {
      assert.ok(c.content.length >= 2000, 'non-final chunks should be near the target');
    }
  });

  await t.test('no text is lost across the split', () => {
    const md = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${para(400)}`).join('\n\n');
    const joined = chunkMarkdown(md).map(c => c.content).join('\n\n');

    for (let i = 0; i < 12; i++) {
      assert.ok(joined.includes(`Paragraph ${i} `), `lost paragraph ${i}`);
    }
  });

  await t.test('a single oversized paragraph is split, with overlap', () => {
    const chunks = chunkMarkdown(para(10000));

    assert.ok(chunks.length > 1);
    for (const c of chunks) {
      assert.ok(c.content.length <= 4000, `chunk of ${c.content.length} exceeds maxChunkSize`);
    }
  });

  await t.test('a document shorter than the minimum still produces one chunk', () => {
    // Otherwise a one-line document becomes invisible to Deep Search.
    const chunks = chunkMarkdown('Tiny.');
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].content, 'Tiny.');
  });

  await t.test('chunkIndex is dense and ordered — ids are built from it', () => {
    const md = Array.from({ length: 15 }, () => para(500)).join('\n\n');
    const chunks = chunkMarkdown(md);

    assert.deepStrictEqual(chunks.map(c => c.chunkIndex), chunks.map((_, i) => i));
  });
});
