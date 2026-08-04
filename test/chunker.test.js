'use strict';

/**
 * Boundary tests for the split rules — where a chunk starts, where it ends, and what must never be
 * dropped on the way.
 *
 * These began as capacity tests: Typesense held its index in RAM at ~1.1 KB per chunk against an
 * average 601-character chunk, so one-chunk-per-paragraph projected to 3.1M chunks / 3.4 GB and
 * accumulating to ~2500 brought it to ~740k. That argument died with Typesense, and the size
 * constants are now inherited rather than derived (see `src/config.js`). What survives is the part
 * that was always about correctness: no text lost, short paragraphs merged rather than dropped,
 * `chunkIndex` dense because ids are built from it.
 */

const test = require('node:test');
const assert = require('node:assert');
const { chunkMarkdown, createChunkAccumulator } = require('../src/chunker');

const para = (n, ch = 'a') => ch.repeat(n);

const {
  maxChunkSize: MAX,
  overlapSize: OVERLAP
} = require('../src/config');

/** Do two chunks share a run of text? The question the old overlap test never asked. */
function shareText(a, b) {
  const tail = a.content.slice(-OVERLAP);
  return tail.length > 0 && b.content.includes(tail.slice(0, Math.min(40, tail.length)));
}

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

  await t.test('a single oversized paragraph is split, and the pieces really do overlap', () => {
    // This test used to assert only `length > 1` and the size ceiling, which is why the overlap
    // bug survived: nothing checked that any text was actually shared.
    const chunks = chunkMarkdown(para(10000, 'x').replace(/x{50}/g, m => m + ' '));

    assert.ok(chunks.length > 1);
    for (const c of chunks) {
      assert.ok(c.content.length <= MAX + OVERLAP,
        `chunk of ${c.content.length} exceeds maxChunkSize + overlap`);
    }
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(shareText(chunks[i - 1], chunks[i]),
        `chunks ${i - 1} and ${i} share no text — overlap did not fire`);
    }
  });

  await t.test('consecutive chunks overlap ACROSS a block boundary', () => {
    // The path that was actually broken. `emit()` called `splitText()`, which returns any block
    // under MAX (4000) unchanged — and blocks are emitted at TARGET (2500). So on the common path
    // splitText was a no-op and consecutive chunks shared nothing.
    const md = Array.from({ length: 20 }, (_, i) => `Para${i} ${para(300, String.fromCharCode(97 + i))}`)
      .join('\n\n');
    const chunks = chunkMarkdown(md);

    assert.ok(chunks.length >= 2, 'need at least two blocks to test a boundary');
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i].content.startsWith(chunks[i - 1].content.slice(-OVERLAP)),
        `chunk ${i} does not begin with the tail of chunk ${i - 1}`);
    }
  });

  await t.test('overlap must not rescue a fragment below the minimum', () => {
    // The trap in prepending overlap: 200 characters of a neighbour's text would lift any sliver
    // over MIN_CHUNK_SIZE, and the surviving chunk would be almost entirely duplicated text. The
    // floor has to measure the block's own contribution.
    const tiny = 'x'.repeat(20);
    const chunks = chunkMarkdown([para(3000, 'a'), tiny].join('\n\n'));

    for (const c of chunks) {
      assert.ok(!c.content.endsWith(tiny) || c.content.length > OVERLAP + tiny.length + 10,
        'a sub-minimum fragment was emitted as its own chunk, padded by overlap');
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

test('createChunkAccumulator', async (t) => {
  // The streaming ingest path feeds sections one at a time and flushes as it goes. If it can
  // produce different boundaries from the whole-string path, there are two chunking rules and the
  // corpus becomes inconsistent depending on which door a document came through. These tests
  // exist to make that impossible to introduce quietly.
  const feed = (sections) => {
    const acc = createChunkAccumulator();
    const out = [];
    for (const s of sections) out.push(...acc.push(s));
    out.push(...acc.end());
    return out;
  };

  await t.test('incremental output is identical to the whole-string path', () => {
    const cases = [
      ['Tiny.'],
      ['# Heading', 'Short line.', 'Another short one.'],
      Array.from({ length: 20 }, (_, i) => para(300, String.fromCharCode(97 + i))),
      Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${para(400)}`),
      [para(10000)],
      // A long run of near-target sections plus a SHORT tail: the tail rule reaches back into the
      // previous block, which is the one thing a naive streaming implementation gets wrong.
      [...Array.from({ length: 5 }, () => para(2400)), 'tail'],
      // Target-sized body then a tail long enough to stand alone.
      [...Array.from({ length: 3 }, () => para(2600)), para(500)]
    ];
    for (const sections of cases) {
      const whole = chunkMarkdown(sections.join('\n\n'));
      assert.deepStrictEqual(feed(sections), whole,
        `streamed output diverged for ${sections.length} sections`);
    }
  });

  await t.test('a short tail still joins the previous block, not a stub of its own', () => {
    const chunks = feed([...Array.from({ length: 3 }, () => para(2600)), 'tail']);
    assert.ok(chunks.length > 0);
    assert.ok(chunks[chunks.length - 1].content.endsWith('tail'),
      'the tail must be appended to the last chunk');
    assert.ok(chunks[chunks.length - 1].content.length > 100,
      'and must not have become a chunk of its own');
  });

  await t.test('blank sections are skipped without consuming an index', () => {
    assert.deepStrictEqual(feed(['', '   ', 'Tiny.', '\n']), chunkMarkdown('Tiny.'));
  });

  await t.test('nothing in yields nothing out', () => {
    assert.deepStrictEqual(feed([]), []);
    assert.deepStrictEqual(feed(['', '  ']), []);
  });
});
