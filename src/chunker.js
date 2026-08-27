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
 * `pageNumber` IS NOT A PDF PAGE. It is a sequence number: the extraction host flattens pages
 * before posting (`extract_text` joins them and drops the index; the OCR path is 25-page batch
 * granular), and the ingest payload carries paragraphs, not pages. It exists because the schema
 * has the field, and the UI labels it "Passage" for that reason. Real page numbers are a citation
 * feature and need host, protocol and API changes.
 */

const {
  maxChunkSize: MAX_CHUNK_SIZE,
  minChunkSize: MIN_CHUNK_SIZE,
  targetChunkSize: TARGET_CHUNK_SIZE,
  overlapSize: OVERLAP_SIZE
} = require('./config');

const { stripPlaceholders, isSeparatorFurniture } = require('./text-quality');

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
 * `pageNumber` is a sequence number, not a PDF page: docling returns one markdown string with no
 * page boundaries. It exists because the DocumentChunk schema has the field.
 */
function createChunkAccumulator() {
  let buffer = '';
  let pending = null;
  let pageNumber = 0;
  let chunkIndex = 0;
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
      // Tail of this chunk's own text, so overlap never compounds across successive chunks.
      carry = own.slice(-OVERLAP_SIZE);
    }
    pageNumber++;
  }

  return {
    /** @param {string} section one paragraph/section, unsplit. Returns chunks completed by it. */
    push(section) {
      const out = [];
      // Strip docling's `<!-- image -->` markup on the way in, so it never reaches a chunk, the
      // index or a Deep Search snippet. A section that was nothing BUT placeholders strips to '' and
      // is dropped by the emptiness check below, which is the case worth having: it carries no words
      // and an index entry made from it matches nothing.
      const trimmed = stripPlaceholders(section);
      // Every non-empty section is kept. This deliberately does NOT drop sections shorter than
      // MIN_CHUNK_SIZE: doing so silently deleted headings, table rows and short lines from the
      // indexed text. MIN_CHUNK_SIZE means only "too small to be worth its own chunk", after
      // merging.
      if (!trimmed) return out;
      buffer = buffer ? `${buffer}\n\n${trimmed}` : trimmed;
      if (buffer.length >= TARGET_CHUNK_SIZE) {
        if (pending !== null) emit(pending, out);
        pending = buffer;
        buffer = '';
      }
      return out;
    },

    /** Flush what is held back. Returns the remaining chunks. */
    end() {
      const out = [];
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
      return out;
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

  const acc = createChunkAccumulator();
  const result = [];
  for (const section of markdown.split(/\n{2,}/)) {
    result.push(...acc.push(section));
  }
  result.push(...acc.end());
  return result;
}

module.exports = { chunkMarkdown, createChunkAccumulator };
