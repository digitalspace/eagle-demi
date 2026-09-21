'use strict';

/**
 * chunker.js — Split text into overlapping chunks for AI Search indexing.
 *
 * Strategy: paragraph/section-aware with overlap.
 *  - Sections accumulate to TARGET_CHUNK_SIZE, then that block is emitted
 *  - A block over MAX_CHUNK_SIZE is split into pieces that overlap by OVERLAP_SIZE
 *  - Consecutive chunks also overlap by OVERLAP_SIZE ACROSS block boundaries — see `emit()`
 *  - A fragment under MIN_CHUNK_SIZE is folded into its neighbour rather than emitted
 *
 * A chunk may therefore run to MAX_CHUNK_SIZE + OVERLAP_SIZE: the ceiling bounds a block's own
 * text, and prepended overlap sits on top of it. Bounded, which is what the ceiling is for.
 *
 * Input: plain text string (markdown from docling-serve).
 * Output: array of { pageNumber, chunkIndex, content } objects.
 *
 * `pageNumber` MEANS ONE OF TWO THINGS and a chunk alone cannot say which, which is why both
 * ingest paths stamp `pageNumbered: true` on the document and its chunks when the markers were
 * there:
 *  - marker-free input, which is every extraction taken before page provenance: a sequence number.
 *    The host flattened the pages before posting, so nothing here can know where one ended, and
 *    the UI labels it "Passage" for that reason.
 *  - input carrying PAGE_MARKER between consecutive pages: the real 1-based PDF page the chunk's
 *    text starts on. A page with at least MIN_CHUNK_SIZE characters closes its block, so a chunk
 *    only spans pages when shorter ones merged into it (backward where a block is held).
 */

const {
  maxChunkSize: MAX_CHUNK_SIZE,
  minChunkSize: MIN_CHUNK_SIZE,
  targetChunkSize: TARGET_CHUNK_SIZE,
  overlapSize: OVERLAP_SIZE
} = require('./config');

const { stripPlaceholders, isSeparatorFurniture } = require('./text-quality');

/**
 * The page separator the extraction host writes between consecutive pages, never at either end.
 *
 * U+000C, the form feed — the break pdftotext and docling have always emitted, and a character a
 * PDF text layer does not carry as content, so it cannot be confused with extracted text.
 */
const PAGE_MARKER = '\f';

/** Did this extraction carry page boundaries? Everything page-numbered hangs off this one test. */
function hasPageMarkers(text) {
  return typeof text === 'string' && text.includes(PAGE_MARKER);
}

/**
 * How many pages the markers describe, 0 when there are none.
 *
 * Counted rather than split: the whole-string path is handed up to 10 MB of markdown, and the
 * count is wanted for one field on one document row. An empty page counts — its marker is still
 * written — so this is markers + 1, which is what keeps the numbering aligned with the PDF.
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
 * Incremental chunker. Feed it one section at a time, call `end()` when there are no more.
 *
 * This exists so the streaming ingest path and the whole-string path share ONE set of chunk
 * boundary rules. A second copy would drift, and this repo has already paid for that once.
 * `chunkMarkdown` below is a thin
 * wrapper over this, which is what keeps `test/chunker.test.js` meaningful for both callers.
 *
 * Both methods RETURN the chunks they emitted, so a streaming caller can flush as it goes and
 * never hold the whole document. Sections accumulate until the buffer reaches TARGET_CHUNK_SIZE:
 * measured on real documents, chunks averaged 601 characters but cost ~1.1 KB of index RAM each,
 * so per-chunk overhead — not the text — dominated. Merging to ~2500 characters cuts the corpus
 * from ~3.1M chunks to ~740k for the same words.
 *
 * One completed block is always held back in `pending`, because the tail rule can retroactively
 * append to it: a short final section joins the previous block rather than becoming a stub. That
 * is only possible if the previous block has not been emitted yet.
 *
 * PAGE MODE IS THE CALLER'S TO DECLARE, never guessed here: a document is paged or it is not and
 * the whole document has to agree on which, so a decision made halfway through would number the
 * blocks before it differently from the ones after. `chunkMarkdown` reads it off the whole string;
 * the streaming ingest door holds blocks until the first page marker or end of stream, no fixed
 * probe window (`ingestChunksStreaming`). In page mode `pageNumber` is the real 1-based page the
 * chunk's text starts on, several chunks can share one, and a page of at least MIN_CHUNK_SIZE
 * characters closes the block it ends. A shorter page joins the block before it, so a divider or
 * plate page never shifts the next page's citation; it joins the next page's text only when there
 * is no block before it (document start) or joining would push that block past MAX_CHUNK_SIZE. A
 * chunk per sub-floor page turned a form-feed-dense file into ~38k chunks of ~50 bytes. Otherwise
 * `pageNumber` is the block sequence number it has always been.
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
      // Only a trailing sliver from splitText, or a document's whole text, can land here short,
      // and an index entry of a few characters matches everything and means nothing. The first
      // chunk is exempt so a document is never empty.
      //
      // Measured against `own`, NEVER against `own + carry`: 200 characters of overlap would
      // otherwise lift every sliver over the floor, and the chunk that survived would be almost
      // entirely text already indexed under its neighbour.
      if (!own || (chunkIndex > 0 && own.length < MIN_CHUNK_SIZE)) continue;

      // Furniture — a chunk that is nothing but rules, dot leaders or form underscores — carries no
      // words, so it can never be the right answer to a query and only spends an index entry. This
      // is the ONLY quality reason acted on here: `classify()` also reports vowelless and
      // fragmented tokens, but those describe damaged TEXT, and dropping them would delete the
      // hardest OCR documents from the index and hide a measurable extraction problem.
      //
      // Guarded on `chunkIndex > 0` for the same reason the size floor is: a document must still
      // produce at least one chunk, or "extracted but entirely furniture" becomes indistinguishable
      // from "never extracted", which is the STARVED signal the audit relies on.
      if (chunkIndex > 0 && isSeparatorFurniture(own)) continue;

      const ownStart = part.start + part.text.search(/\S/);
      const page = pageMarkers ? pageAt(block.pages, ownStart) : pageNumber;

      // The overlap itself, and the bug this fixes. `splitText` already overlaps consecutive
      // pieces of ONE oversized block (`step = MAX - OVERLAP`), but it returns any block under
      // MAX unchanged — and blocks are emitted at TARGET (2500), well under MAX (4000). So on the
      // common path it returned a single piece and consecutive chunks shared nothing at all.
      // Only the first part needs this; later parts already carry splitText's own overlap.
      //
      // Joined with '\n\n' because that is exactly how the two blocks sat in the source: `push()`
      // accumulates sections with the same separator. Reproducing it means a phrase that spanned
      // the boundary now appears in this chunk the way it was written, which is the entire point —
      // any other joiner would put a break through the middle of the phrase being rescued.
      //
      // In page mode the overlap must sit on the page the chunk is numbered with: page N's wording
      // in a chunk that says N+1 sends a reader following the citation to the wrong page. The cost
      // is a sentence running across a page break is indexed once, under the page it started on.
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
    // Strip docling's `<!-- image -->` markup on the way in, so it never reaches a chunk, the
    // index or a Deep Search snippet. A section that was nothing BUT placeholders strips to '' and
    // is dropped by the emptiness check below, which is the case worth having: it carries no words
    // and an index entry made from it matches nothing.
    const trimmed = stripPlaceholders(section);
    // Every non-empty section is kept. This deliberately does NOT drop sections shorter than
    // MIN_CHUNK_SIZE: doing so silently deleted headings, table rows and short lines from the
    // indexed text. MIN_CHUNK_SIZE means only "too small to be worth its own chunk", after
    // merging.
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
   * Step to the next page. A page with enough text closes its block, so the next page starts a
   * fresh one. A shorter page (an empty one included) joins the held block before it; with none, or
   * no room under MAX_CHUNK_SIZE, its text stays to merge forward with the next page.
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
        // SPLIT FIRST, so every page boundary is seen. Sections arrive split on blank lines and a
        // page ends wherever it ends, as often mid-section as not. Two markers in a row are an
        // EMPTY PAGE, which `split` yields as an empty part: it contributes no text and still
        // consumes its number, which is what keeps the pages after it aligned with the PDF.
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
