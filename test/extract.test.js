'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');

const { splitAndExtract, BATCH_PAGES } = require('../src/extract');

/**
 * The batching exists to bound peak memory: docling-serve is sent BATCH_PAGES pages at a time
 * rather than a whole document, because a 5,000-page PDF as one request is what OOM-killed the
 * extraction worker. Nothing asserted any of it until now — the file had no test at all while it
 * was a Mongo-driven script, and the driver was the only reason it looked untestable.
 *
 * `extract` is injected, so these run with no docling-serve and no network.
 */

/** A real PDF with `pages` blank pages — pdf-lib is already a dependency, so no fixture file. */
async function pdfOf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return Buffer.from(await doc.save());
}

/** Records every call and returns identifiable markdown, so order can be asserted. */
function recorder() {
  const calls = [];
  return {
    calls,
    extract: async (buffer, filename) => {
      calls.push({ filename, bytes: buffer.length });
      return `md:${filename}`;
    }
  };
}

test('splitAndExtract', async (t) => {
  await t.test('a PDF over the batch size is split into ceil(pages/BATCH_PAGES) requests', async () => {
    const { calls, extract } = recorder();
    const buf = await pdfOf(25);

    await splitAndExtract(buf, 'big.pdf', { extract });

    assert.strictEqual(BATCH_PAGES, 10, 'these expectations assume the default batch size');
    assert.strictEqual(calls.length, 3, '25 pages at 10 per batch is 3 requests');
    assert.deepStrictEqual(calls.map(c => c.filename),
      ['big-batch1.pdf', 'big-batch2.pdf', 'big-batch3.pdf']);
  });

  await t.test('batch markdown is joined in page order', async () => {
    // Out-of-order concatenation would interleave one document's text with another part of itself,
    // and every chunk built from it would straddle a seam that does not exist in the source.
    const { extract } = recorder();
    const md = await splitAndExtract(await pdfOf(25), 'big.pdf', { extract });

    assert.strictEqual(md, ['md:big-batch1.pdf', 'md:big-batch2.pdf', 'md:big-batch3.pdf'].join('\n\n'));
  });

  await t.test('every page is covered exactly once, with no gap at the tail', async () => {
    // The last batch is short (25 = 10 + 10 + 5). An off-by-one here silently drops the tail of
    // every long document, which reads downstream as "the text just is not in this PDF".
    // Assert on the ACTUAL page count of each buffer sent, not on the filenames.
    const calls = [];
    const extract = async (buffer, filename) => {
      const doc = await PDFDocument.load(buffer);
      calls.push({ filename, pages: doc.getPageCount() });
      return 'md';
    };

    await splitAndExtract(await pdfOf(25), 'big.pdf', { extract });

    assert.deepStrictEqual(calls.map(c => c.pages), [10, 10, 5]);
    assert.strictEqual(calls.reduce((n, c) => n + c.pages, 0), 25, 'no page may be lost or repeated');
  });

  await t.test('a PDF at or under the batch size is sent whole, unmodified', async () => {
    const { calls, extract } = recorder();
    const buf = await pdfOf(BATCH_PAGES);

    await splitAndExtract(buf, 'small.pdf', { extract });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].filename, 'small.pdf', 'no batch suffix on a whole-file send');
    assert.strictEqual(calls[0].bytes, buf.length, 'the buffer must not be re-encoded');
  });

  await t.test('a non-PDF is sent whole without going near pdf-lib', async () => {
    const { calls, extract } = recorder();
    const buf = Buffer.from('not a pdf at all');

    const md = await splitAndExtract(buf, 'report.docx', { extract });

    assert.strictEqual(md, 'md:report.docx');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].bytes, buf.length);
  });

  await t.test('an unparseable PDF falls back to a whole-file send rather than throwing', async () => {
    // docling-serve can often read a PDF that pdf-lib refuses, so a parse failure must degrade to
    // "send it whole", not fail the document.
    const { calls, extract } = recorder();
    const buf = Buffer.from('%PDF-1.4 truncated garbage');

    const md = await splitAndExtract(buf, 'broken.pdf', { extract });

    assert.strictEqual(md, 'md:broken.pdf');
    assert.strictEqual(calls.length, 1);
  });
});
