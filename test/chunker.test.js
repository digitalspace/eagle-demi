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
  overlapSize: OVERLAP,
  targetChunkSize: TARGET,
  minChunkSize: MIN
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
      // Derived from TARGET rather than hard-coded at 2000, so this asserts the configured target
      // actually reaches the chunker instead of asserting a number that happens to match it.
      assert.ok(c.content.length >= TARGET * 0.8,
        `non-final chunks should be near the target (${TARGET}), got ${c.content.length}`);
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
    assert.ok(chunks[chunks.length - 1].content.length > MIN,
      `and must not have become a chunk of its own (MIN=${MIN})`);
  });

  await t.test('blank sections are skipped without consuming an index', () => {
    assert.deepStrictEqual(feed(['', '   ', 'Tiny.', '\n']), chunkMarkdown('Tiny.'));
  });

  await t.test('nothing in yields nothing out', () => {
    assert.deepStrictEqual(feed([]), []);
    assert.deepStrictEqual(feed(['', '  ']), []);
  });
});

// The size constants are not free parameters once a corpus exists. Chunk ids are built from
// `chunkIndex`, so re-chunking the same document at a different TARGET or MIN produces a different
// number of chunks with different ids — the old rows are not overwritten, they are orphaned, and
// they stay searchable because the AI Search indexer's `_ts` high-water mark never revisits a row
// it has already seen.
//
// The behavioural tests above read these values from `src/config.js`, which proves the configured
// number reaches the chunker but CANNOT notice the number changing — they move with it. This is the
// canary that does not move. It exists to fail, loudly, the moment someone edits a default or sets
// the env var, so that re-chunking the corpus is a decision rather than an accident.
test('the chunk size defaults are pinned, because changing one orphans the corpus', () => {
  const { maxChunkSize, targetChunkSize, minChunkSize, overlapSize } = require('../src/config');

  assert.deepStrictEqual(
    { maxChunkSize, targetChunkSize, minChunkSize, overlapSize },
    { maxChunkSize: 4000, targetChunkSize: 2500, minChunkSize: 100, overlapSize: 200 },
    'Chunk sizing changed. Every chunk already written was produced at the OLD sizes and will not ' +
    'be replaced by a re-run — it will be duplicated and left searchable. If this change is ' +
    'intended, purge and re-extract the corpus, then update these expected values in the same commit.'
  );
});

// The intake cleaner. docling emits `<!-- image -->` for every picture and it cannot be turned off
// (image_export_mode admits only placeholder/embedded/referenced), so the markup reaches the
// chunker on every document and used to reach the index and the Deep Search snippet with it.
test('intake cleaning', async (t) => {
  await t.test('image placeholders never reach a chunk', () => {
    const chunks = chunkMarkdown('The proponent <!-- image --> filed a report.');

    assert.strictEqual(chunks.length, 1);
    assert.ok(!/<!--/.test(chunks[0].content), 'placeholder markup survived into the chunk');
    assert.ok(chunks[0].content.includes('proponent'), 'and the surrounding words must survive');
    assert.ok(chunks[0].content.includes('filed a report'));
  });

  await t.test('a section that is nothing but placeholders produces no chunk', () => {
    assert.deepStrictEqual(chunkMarkdown('<!-- image -->'), []);
    assert.deepStrictEqual(chunkMarkdown('<!-- image -->\n\n<!--image-->\n\n<!--  IMAGE  -->'), []);
  });

  await t.test('placeholder-only sections do not consume a chunkIndex', () => {
    // chunkIndex is dense because ids are built from it. A placeholder section that reserved an
    // index would leave a hole and the ids would stop lining up with the chunk count.
    const body = Array.from({ length: 6 }, (_, i) => para(500, String.fromCharCode(97 + i)));
    const withImages = body.flatMap(p => [p, '<!-- image -->']);

    assert.deepStrictEqual(
      chunkMarkdown(withImages.join('\n\n')).map(c => c.chunkIndex),
      chunkMarkdown(body.join('\n\n')).map(c => c.chunkIndex)
    );
  });

  await t.test('a chunk of pure separator furniture is dropped', () => {
    // A horizontal rule carries no words, so it can never be the right answer to a query — it only
    // occupies an index entry and a result slot.
    const rule = '_'.repeat(3000);
    const chunks = chunkMarkdown([para(3000, 'a'), rule, para(3000, 'b')].join('\n\n'));

    // By SHARE, not `^furniture-only$`: every chunk carries 200 characters of overlap from its
    // neighbour, so even a pure rule is never entirely underscores and an exact-match assertion
    // would pass whether or not the drop fired.
    for (const c of chunks) {
      const furniture = (c.content.match(/[_.=-]/g) || []).length;
      assert.ok(furniture / c.content.length < 0.9,
        `a chunk that is ${Math.round(100 * furniture / c.content.length)}% furniture reached the index`);
    }
  });

  await t.test('a table of contents is KEPT — dot leaders are not damage', () => {
    // The rule that makes this safe is `alphaRatio < 0.35`. Measured on the corpus, a real TOC runs
    // separatorRatio 0.40-0.58 while carrying alphaRatio 0.37-0.56, because it is mostly section
    // titles with dot leaders between them. Those titles are findable content.
    const toc = Array.from({ length: 40 }, (_, i) =>
      `Section ${i} Environmental Assessment Certificate Application ${'.'.repeat(20)} ${i * 3}`
    ).join('\n');
    const chunks = chunkMarkdown([para(3000, 'a'), toc, para(3000, 'b')].join('\n\n'));

    assert.ok(chunks.some(c => c.content.includes('Environmental Assessment Certificate')),
      'the table of contents was dropped as furniture');
  });

  await t.test('damaged OCR text is KEPT, because it is still text', () => {
    // The restraint that matters. classify() would call this garbage on `vowelless-tokens`, but
    // dropping it would delete the hardest OCR documents from the index and turn a measurable
    // extraction problem into an invisible one.
    const salad = Array.from({ length: 300 }, () => 'brtn wgh mrkt schm').join(' ');
    const chunks = chunkMarkdown([para(3000, 'a'), salad, para(3000, 'b')].join('\n\n'));

    assert.ok(chunks.some(c => c.content.includes('brtn wgh mrkt')),
      'damaged text must stay searchable — the retrieval run is what judges it');
  });

  await t.test('a document made entirely of furniture still produces one chunk', () => {
    // Otherwise "extracted but entirely furniture" becomes indistinguishable from "never
    // extracted", which is the STARVED signal the audit relies on.
    const chunks = chunkMarkdown('_'.repeat(3000));

    assert.strictEqual(chunks.length, 1);
  });

  await t.test('the streaming path cleans identically to the whole-string path', () => {
    // Two chunking rules would make the corpus depend on which door a document came through.
    const sections = [para(2600, 'a'), '<!-- image -->', '_'.repeat(3000), para(2600, 'b')];
    const acc = createChunkAccumulator();
    const streamed = [];
    for (const s of sections) streamed.push(...acc.push(s));
    streamed.push(...acc.end());

    assert.deepStrictEqual(streamed, chunkMarkdown(sections.join('\n\n')));
  });
});
