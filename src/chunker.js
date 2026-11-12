'use strict';

/**
 * A chunk may reach MAX_CHUNK_SIZE + OVERLAP_SIZE: overlap sits on top of the block ceiling.
 * `pageNumber` is the real 1-based PDF page with PAGE_MARKER input, else a block sequence number.
 */

const {
  maxChunkSize: MAX_CHUNK_SIZE,
  minChunkSize: MIN_CHUNK_SIZE,
  targetChunkSize: TARGET_CHUNK_SIZE,
  overlapSize: OVERLAP_SIZE
} = require('./config');

const { stripPlaceholders, isSeparatorFurniture } = require('./text-quality');

/**
 * Form feed, written between pages and never at either end; a PDF text layer never carries it.
 */
const PAGE_MARKER = '\f';

/** Did this extraction carry page boundaries? Everything page-numbered hangs off this one test. */
function hasPageMarkers(text) {
  return typeof text === 'string' && text.includes(PAGE_MARKER);
}

/**
 * Counted, not split: input can be 10 MB. An empty page still has its marker, so markers + 1.
 */
function pageCountOf(text) {
  if (!hasPageMarkers(text)) return 0;
  let count = 1;
  for (let at = text.indexOf(PAGE_MARKER); at !== -1; at = text.indexOf(PAGE_MARKER, at + 1)) {
    count++;
  }
  return count;
}

/**
 * Split a single block of text into overlapping sub-chunks, each with its offset in the block.
 * @param {string} text
 * @returns {{ start: number, text: string }[]}
 */
function splitText(text) {
  if (text.length <= MAX_CHUNK_SIZE) return [{ start: 0, text }];
  const chunks = [];
  const step   = MAX_CHUNK_SIZE - OVERLAP_SIZE;
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + MAX_CHUNK_SIZE, text.length);
    chunks.push({ start, text: text.slice(start, end) });
    if (end === text.length) break;
  }
  return chunks;
}

/** The page `offset` of a block falls on. `pages` lists where each page's text starts in it. */
function pageAt(pages, offset) {
  let page = pages[0].page;
  for (const p of pages) {
    if (p.at > offset) break;
    page = p.page;
  }
  return page;
}

/** Join two held blocks with the section separator, keeping their page starts aligned. */
function joinHeld(a, b) {
  if (!a) return b;
  const shift = a.text.length + 2;
  const pages = a.pages.concat(b.pages
    .map(p => ({ at: p.at + shift, page: p.page }))
    .filter((p, i) => i > 0 || p.page !== a.pages[a.pages.length - 1].page));
  return { text: `${a.text}\n\n${b.text}`, pages };
}

/**
 * Shared by streaming ingest and `chunkMarkdown`, so both follow one set of boundary rules.
 * Page mode is the caller's to declare: the whole document must agree on it.
 *
 * @param {{ pageMarkers?: boolean }} [options]
 */
function createChunkAccumulator(options = {}) {
  const pageMarkers = options.pageMarkers === true;
  // Held blocks are `{ text, pages }`, where `pages` marks the offset each page's text starts at.
  let buffer = null;
  let pending = null;
  let pageNumber = pageMarkers ? 1 : 0;
  let chunkIndex = 0;
  // Characters the page being read has contributed; decides whether its end closes a block.
  let pageChars = 0;
  // Tail of the last emitted chunk, prepended to the next one. Per-accumulator, so it cannot leak
  // text from one document into another.
  let carry = '';
  let carryPage = 0;

  function emit(block, out) {
    for (const part of splitText(block.text)) {
      // `own` is this block's OWN contribution, before any overlap is prepended. Every size test
      // below measures it rather than the final content — see the MIN_CHUNK_SIZE note.
      const own = part.text.trim();
      // A sliver matches everything and means nothing; the first chunk is exempt so a document is
      // never empty. Measured without the carry, or the overlap would lift every sliver.
      if (!own || (chunkIndex > 0 && own.length < MIN_CHUNK_SIZE)) continue;

      // Furniture carries no words to find; damaged OCR text does, so only furniture is dropped.
      // First chunk always kept: a document with no chunks reads as never extracted.
      if (chunkIndex > 0 && isSeparatorFurniture(own)) continue;

      const ownStart = part.start + part.text.search(/\S/);
      const page = pageMarkers ? pageAt(block.pages, ownStart) : pageNumber;

      // Overlap across blocks: splitText only overlaps pieces of one oversized block. '\n\n' is the
      // source separator. In page mode the carry joins only on the same page, so citations hold.
      const withCarry = part.start === 0 && carry && (!pageMarkers || carryPage === page);
      const content = withCarry ? `${carry}\n\n${own}` : own;

      out.push({ pageNumber: page, chunkIndex, content });
      chunkIndex++;
      // Tail of this chunk's own text, so overlap never compounds across successive chunks.
      carry = own.slice(-OVERLAP_SIZE);
      if (pageMarkers) carryPage = pageAt(block.pages, ownStart + own.length - carry.length);
    }
    // Only when the blocks ARE the numbering. In page mode the marker steps the page.
    if (!pageMarkers) pageNumber++;
  }

  /** Move the buffer to `pending`. A short buffer joins the previous block instead of being a stub. */
  function settle(out) {
    if (!buffer) return;
    if (pending && buffer.text.length < MIN_CHUNK_SIZE) {
      pending = joinHeld(pending, buffer);
    } else {
      if (pending) emit(pending, out);
      pending = buffer;
    }
    buffer = null;
  }

  /** Emit everything held. A short document still gets its one chunk. */
  function flushHeld(out) {
    settle(out);
    if (pending) {
      emit(pending, out);
      pending = null;
    }
  }

  /** One section into the buffer. The marker split runs before this, so it never sees a marker. */
  function accumulate(section, out) {
    // Strips docling's `<!-- image -->` markup; a placeholder-only section strips to '' and drops.
    const trimmed = stripPlaceholders(section);
    // Short sections are kept on purpose: dropping them would lose headings and table rows.
    // MIN_CHUNK_SIZE applies only after merging.
    if (!trimmed) return;
    pageChars += trimmed.length;
    buffer = joinHeld(buffer, { text: trimmed, pages: [{ at: 0, page: pageNumber }] });
    if (buffer.text.length >= TARGET_CHUNK_SIZE) {
      if (pending) emit(pending, out);
      pending = buffer;
      buffer = null;
    }
  }

  /**
   * A page with MIN_CHUNK_SIZE of text closes its block. A shorter one joins the held block before
   * it, so a divider page never shifts the next citation; with no room, it merges forward.
   */
  function endPage(out) {
    if (pageChars >= MIN_CHUNK_SIZE) {
      settle(out);
    } else if (buffer && pending && pending.text.length + 2 + buffer.text.length <= MAX_CHUNK_SIZE) {
      // The MAX bound keeps a run of short pages from growing one held block without limit.
      pending = joinHeld(pending, buffer);
      buffer = null;
    }
    pageChars = 0;
    pageNumber++;
  }

  return {
    /** @param {string} section one paragraph/section, unsplit. Returns chunks completed by it. */
    push(section) {
      const out = [];
      if (pageMarkers && hasPageMarkers(section)) {
        // Pages end mid-section as often as not. Two markers in a row are an empty page that
        // still takes its number, keeping later pages aligned with the PDF.
        const pages = section.split(PAGE_MARKER);
        for (let i = 0; i < pages.length; i++) {
          if (i > 0) endPage(out);
          accumulate(pages[i], out);
        }
        return out;
      }
      accumulate(section, out);
      return out;
    },

    /** Flush what is held back. Returns the remaining chunks. */
    end() {
      const out = [];
      flushHeld(out);
      return out;
    },

    /**
     * How many pages the markers described, 0 when there were none. Read after `end()`: the count
     * starts at 1 and steps once per marker, so it lands on the last page's own number.
     */
    pageCount() {
      return pageMarkers ? pageNumber : 0;
    }
  };
}

/**
 * Convert a whole docling markdown string into chunks.
 *
 * @param {string} markdown
 * @returns {{ pageNumber: number, chunkIndex: number, content: string }[]}
 */
function chunkMarkdown(markdown) {
  if (!markdown || !markdown.trim()) return [];

  const acc = createChunkAccumulator({ pageMarkers: hasPageMarkers(markdown) });
  const result = [];
  for (const section of markdown.split(/\n{2,}/)) {
    result.push(...acc.push(section));
  }
  result.push(...acc.end());
  return result;
}

module.exports = { chunkMarkdown, createChunkAccumulator, hasPageMarkers, pageCountOf, PAGE_MARKER };
