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
 *  - input carrying PAGE_MARKER between consecutive pages: the real 1-based PDF page. Blocks are
 *    cut at every marker, so a chunk holds text from one page only and "Page N" is quotable.
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
 * Split a single block of text into overlapping sub-chunks.
 * @param {string} text
 * @returns {string[]}
 */
function splitText(text) {
  if (text.length <= MAX_CHUNK_SIZE) return [text];
  const chunks = [];
  const step   = MAX_CHUNK_SIZE - OVERLAP_SIZE;
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + MAX_CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
  }
  return chunks;
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
 * the streaming ingest door probes its first blocks (`ingestChunksStreaming`). In page mode
 * `pageNumber` is the real 1-based page, several blocks can share one, and a block never spans a
 * marker. Otherwise it is the block sequence number it has always been.
 *
 * @param {{ pageMarkers?: boolean }} [options]
 */
function createChunkAccumulator(options = {}) {
  const pageMarkers = options.pageMarkers === true;
  let buffer = '';
  let pending = null;
  let pageNumber = pageMarkers ? 1 : 0;
  let chunkIndex = 0;
  // Chunks emitted for the page being accumulated. Only page mode reads it: the size floor's
  // exception is per PAGE there, not per document — see `emit`.
  let chunksOnPage = 0;
  // Tail of the last emitted chunk, prepended to the next one. Per-accumulator, so it cannot leak
  // text from one document into another.
  let carry = '';

  function emit(block, out) {
    const parts = splitText(block);
    for (let i = 0; i < parts.length; i++) {
      // `own` is this block's OWN contribution, before any overlap is prepended. Every size test
      // below measures it rather than the final content — see the MIN_CHUNK_SIZE note.
      const own = parts[i].trim();
      // Only a trailing sliver from splitText can land here, and an index entry of a few
      // characters matches everything and means nothing. `chunkIndex` doubles as the running
      // total, so this is the same "not the very first chunk" test the whole-string version made
      // against result.length.
      //
      // Measured against `own`, NEVER against `own + carry`: 200 characters of overlap would
      // otherwise lift every sliver over the floor, and the chunk that survived would be almost
      // entirely text already indexed under its neighbour.
      //
      // IN PAGE MODE THE EXEMPT UNIT IS THE PAGE, not the document, and for the same reason: a
      // page's text has nowhere to merge to any more — the boundary flush is what stops a block
      // spanning one — so the floor would silently delete a cover page, a plate caption or a
      // signature page from the index. A document is never empty either way; the first chunk of a
      // page is simply also exempt.
      const firstOfUnit = pageMarkers ? chunksOnPage === 0 : chunkIndex === 0;
      if (!own || (!firstOfUnit && own.length < MIN_CHUNK_SIZE)) continue;

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

      // The overlap itself, and the bug this fixes. `splitText` already overlaps consecutive
      // pieces of ONE oversized block (`step = MAX - OVERLAP`), but it returns any block under
      // MAX unchanged — and blocks are emitted at TARGET (2500), well under MAX (4000). So on the
      // common path it returned a single piece and consecutive chunks shared nothing at all.
      // Only i === 0 needs this; later parts already carry splitText's own overlap.
      //
      // Joined with '\n\n' because that is exactly how the two blocks sat in the source: `push()`
      // accumulates sections with the same separator. Reproducing it means a phrase that spanned
      // the boundary now appears in this chunk the way it was written, which is the entire point —
      // any other joiner would put a break through the middle of the phrase being rescued.
      const content = (i === 0 && carry) ? `${carry}\n\n${own}` : own;

      out.push({ pageNumber, chunkIndex, content });
      chunkIndex++;
      chunksOnPage++;
      // Tail of this chunk's own text, so overlap never compounds across successive chunks.
      carry = own.slice(-OVERLAP_SIZE);
    }
    // Only when the blocks ARE the numbering. In page mode the marker steps the page, so several
    // blocks share one page number and the numbers match the PDF's.
    if (!pageMarkers) pageNumber++;
  }

  /**
   * Emit everything held: the completed block, then whatever the buffer has. `end()` and a page
   * boundary are the same operation — nothing may be carried past either — so they share it.
   */
  function flushHeld(out) {
    if (buffer) {
      // The tail joins the previous block rather than becoming a stub of its own — unless it is
      // the only content there is, in which case a short document still gets one chunk.
      if (pending !== null && buffer.length < MIN_CHUNK_SIZE) {
        pending += `\n\n${buffer}`;
      } else {
        if (pending !== null) emit(pending, out);
        pending = buffer;
      }
      buffer = '';
    }
    if (pending !== null) {
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
    buffer = buffer ? `${buffer}\n\n${trimmed}` : trimmed;
    if (buffer.length >= TARGET_CHUNK_SIZE) {
      if (pending !== null) emit(pending, out);
      pending = buffer;
      buffer = '';
    }
  }

  /**
   * Close the page being accumulated and step to the next one.
   *
   * THE OVERLAP IS DROPPED HERE, deliberately. `carry` rescues a phrase cut in half by a boundary
   * the CHUNKER invented; a page break is a boundary the DOCUMENT has. Prepending the tail of
   * page N to the first chunk of page N+1 would put page N's wording in a chunk whose id and
   * `pageNumber` both say N+1, so a reader following "Page 12" would land on a sentence printed on
   * page 11 — and the citation, which is the entire point of real page numbers, would be wrong.
   * The cost is a sentence running across the break: it is indexed once, under the page it started
   * on, rather than in both.
   */
  function endPage(out) {
    flushHeld(out);
    carry = '';
    chunksOnPage = 0;
    pageNumber++;
  }

  return {
    /** @param {string} section one paragraph/section, unsplit. Returns chunks completed by it. */
    push(section) {
      const out = [];
      if (pageMarkers && hasPageMarkers(section)) {
        // SPLIT FIRST, so no block can span a marker. Sections arrive split on blank lines and a
        // page ends wherever it ends, as often mid-section as not. Two markers in a row are an
        // EMPTY PAGE, which `split` yields as an empty part: it contributes no chunk and still
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
