'use strict';

/**
 * No worker calls this: extraction runs on an external host that POSTs to `/documents/:id/chunks`.
 * Kept for when extraction moves into Azure; see the Extraction-Pipeline wiki page.
 */

// Node 20+ provides fetch, FormData, Blob as globals — no import needed.
const { PDFDocument } = require('pdf-lib');
const { logger } = require('./utils/logger');
const config = require('./config');

// Pages per batch when pre-splitting large PDFs (caps peak worker memory)
const BATCH_PAGES = parseInt(process.env.DEMI_BATCH_PAGES || '10', 10);

// File extensions handled by docling-serve
const SUPPORTED_EXTENSIONS = new Set([
  'pdf', 'PDF', '.pdf', '.PDF',
  'docx', 'DOCX', '.docx', '.DOCX',
  'doc',  'DOC',  '.doc',  '.DOC',
  'pptx', 'PPTX', '.pptx', '.PPTX',
  'xlsx', 'XLSX', '.xlsx', '.XLSX',
]);

// ── docling-serve helper ──────────────────────────────────────────────────────

/**
 * Send a file buffer to docling-serve and return the extracted markdown.
 * @param {Buffer} buffer
 * @param {string} filename  - used for MIME detection by docling-serve
 * @returns {Promise<string>}
 */
async function extractWithDocling(buffer, filename) {
  const form = new FormData();
  form.append('files', new Blob([buffer]), filename);
  form.append(
    'options',
    JSON.stringify({ to_formats: ['md'], return_as_file: false }),
    { type: 'application/json' },
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.doclingTimeout);

  try {
    const res = await fetch(`${config.doclingUrl}/v1/convert/file`, {
      method:  'POST',
      headers: { 'X-Api-Key': config.doclingKey },
      body:    form,
      signal:  controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`docling-serve HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    // docling-serve returns { document: { md_content: "..." }, ... }
    const md = json?.document?.md_content || json?.documents?.[0]?.md_content || '';
    if (!md) throw new Error('docling-serve returned empty markdown');
    return md;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends large PDFs in BATCH_PAGES-page batches, one at a time, to bound peak memory.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {object} [opts]
 * @param {Function} [opts.extract]  the docling call, injectable so the batching can be tested
 *                                   without a docling-serve instance
 * @returns {Promise<string>}
 */
async function splitAndExtract(buffer, filename, opts = {}) {
  const extract = opts.extract || extractWithDocling;
  const isPdf = /\.pdf$/i.test(filename);
  if (!isPdf) return extract(buffer, filename);

  let srcPdf;
  let pageCount;
  try {
    srcPdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
    // Inside the try: a truncated PDF often loads and fails only on the page walk, and
    // docling-serve can often read whole what pdf-lib cannot.
    pageCount = srcPdf.getPageCount();
  } catch (err) {
    // Unparseable PDF — fall back to whole-file send
    logger.warn(`    pdf-lib parse failed (${err.message}); sending whole file`);
    return extract(buffer, filename);
  }

  if (pageCount <= BATCH_PAGES) return extract(buffer, filename);

  const totalBatches = Math.ceil(pageCount / BATCH_PAGES);
  const baseName = filename.replace(/\.[^.]+$/, '');
  const parts = [];

  for (let b = 0; b < totalBatches; b++) {
    const start = b * BATCH_PAGES;
    const end = Math.min(start + BATCH_PAGES, pageCount);
    const indices = Array.from({ length: end - start }, (_, i) => start + i);

    const batchDoc = await PDFDocument.create();
    const copied = await batchDoc.copyPages(srcPdf, indices);
    copied.forEach((p) => batchDoc.addPage(p));
    const batchBuf = Buffer.from(await batchDoc.save());

    // Sequential, not Promise.all: the point of batching is to bound peak memory, and issuing
    // every batch at once would hold the whole document in flight again.
    const md = await extract(batchBuf, `${baseName}-batch${b + 1}.pdf`);
    parts.push(md);
  }
  return parts.join('\n\n');
}

module.exports = {
  extractWithDocling,
  splitAndExtract,
  BATCH_PAGES,
  SUPPORTED_EXTENSIONS
};
