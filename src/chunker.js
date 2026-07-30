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
 * Convert docling markdown into chunks.
 *
 * Splits on double newline (paragraph/section boundaries), then ACCUMULATES paragraphs until the
 * buffer reaches TARGET_CHUNK_SIZE. Accumulating rather than emitting one chunk per paragraph is
 * what keeps the index affordable: measured on real documents, chunks averaged 601 characters but
 * cost ~1.1 KB of Typesense RAM each, so per-chunk overhead — not the text — dominated. Merging to
 * ~2500 characters cuts the corpus from ~3.1M chunks to ~740k for the same words.
 *
 * `pageNumber` is a sequence number, not a PDF page: docling returns one markdown string with no
 * page boundaries. It exists because the DocumentChunk schema has the field.
 *
 * @param {string} markdown
 * @returns {{ pageNumber: number, chunkIndex: number, content: string }[]}
 */
function chunkMarkdown(markdown) {
  if (!markdown || !markdown.trim()) return [];

  // Every non-empty paragraph is kept. This deliberately does NOT drop paragraphs shorter than
  // MIN_CHUNK_SIZE: doing so silently deleted headings, table rows and short lines from the
  // indexed text, and at a larger minimum it would have discarded almost the entire document.
  // MIN_CHUNK_SIZE now means only "too small to be worth its own chunk", applied after merging.
  const sections = markdown.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);

  const merged = [];
  let buffer = '';
  for (const section of sections) {
    buffer = buffer ? `${buffer}\n\n${section}` : section;
    if (buffer.length >= TARGET_CHUNK_SIZE) {
      merged.push(buffer);
      buffer = '';
    }
  }
  if (buffer) {
    // The tail joins the previous chunk rather than becoming a stub of its own — unless it is the
    // only content there is, in which case a short document still gets one chunk.
    if (merged.length > 0 && buffer.length < MIN_CHUNK_SIZE) {
      merged[merged.length - 1] += `\n\n${buffer}`;
    } else {
      merged.push(buffer);
    }
  }

  const result = [];
  let pageNumber = 0;
  let chunkIndex = 0;

  for (const block of merged) {
    for (const sub of splitText(block)) {
      const content = sub.trim();
      // Only a trailing sliver from splitText can land here, and an index entry of a few
      // characters matches everything and means nothing.
      if (!content || (result.length > 0 && content.length < MIN_CHUNK_SIZE)) continue;
      result.push({ pageNumber, chunkIndex, content });
      chunkIndex++;
    }
    pageNumber++;
  }

  return result;
}

module.exports = { chunkMarkdown };
