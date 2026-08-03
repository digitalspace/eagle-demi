'use strict';

/**
 * chunker.js — Split text into overlapping chunks for Typesense indexing.
 *
 * Strategy: paragraph/section-aware with overlap.
 *  - If text <= MAX_CHUNK_SIZE: single chunk
 *  - If text > MAX_CHUNK_SIZE: split into sub-chunks with OVERLAP_SIZE overlap
 *  - If chunk < MIN_CHUNK_SIZE: merge with next
 *
 * Input: plain text string (markdown from docling-serve).
 * Output: array of { pageNumber, chunkIndex, content } objects.
 */

const {
  maxChunkSize: MAX_CHUNK_SIZE,
  minChunkSize: MIN_CHUNK_SIZE,
  targetChunkSize: TARGET_CHUNK_SIZE,
  overlapSize: OVERLAP_SIZE
} = require('./config');

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
 * boundary rules. A second copy would drift, and this repo has already paid for that once — the
 * whole reason `CLAUDE.md` stopped restating `MIGRATION.md`. `chunkMarkdown` below is a thin
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

  function emit(block, out) {
    for (const sub of splitText(block)) {
      const content = sub.trim();
      // Only a trailing sliver from splitText can land here, and an index entry of a few
      // characters matches everything and means nothing. `chunkIndex` doubles as the running
      // total, so this is the same "not the very first chunk" test the whole-string version made
      // against result.length.
      if (!content || (chunkIndex > 0 && content.length < MIN_CHUNK_SIZE)) continue;
      out.push({ pageNumber, chunkIndex, content });
      chunkIndex++;
    }
    pageNumber++;
  }

  return {
    /** @param {string} section one paragraph/section, unsplit. Returns chunks completed by it. */
    push(section) {
      const out = [];
      const trimmed = String(section).trim();
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
