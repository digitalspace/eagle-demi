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

const { maxChunkSize: MAX_CHUNK_SIZE, minChunkSize: MIN_CHUNK_SIZE, overlapSize: OVERLAP_SIZE } = require('./config');

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
 * Convert docling-serve markdown output into chunks.
 *
 * Docling returns a single markdown string. We split on double-newline
 * (paragraph/section boundaries) and treat each block as a "page" for
 * backwards compatibility with the DocumentChunk schema (pageNumber field).
 *
 * @param {string} markdown  - Full markdown from docling-serve
 * @returns {{ pageNumber: number, chunkIndex: number, content: string }[]}
 */
function chunkMarkdown(markdown) {
  if (!markdown || !markdown.trim()) return [];

  // Split on double newline to get logical sections
  const sections = markdown.split(/\n{2,}/).map(s => s.trim()).filter(s => s.length >= MIN_CHUNK_SIZE);

  // Merge tiny sections into previous
  const merged = [];
  for (const section of sections) {
    if (merged.length > 0 && merged[merged.length - 1].length < MIN_CHUNK_SIZE) {
      merged[merged.length - 1] += '\n\n' + section;
    } else {
      merged.push(section);
    }
  }

  // Assign page numbers and chunk indices
  const result = [];
  let pageNumber  = 0;
  let chunkIndex  = 0;

  for (const block of merged) {
    const subChunks = splitText(block);
    for (const sub of subChunks) {
      if (sub.trim().length < MIN_CHUNK_SIZE) continue;
      result.push({ pageNumber, chunkIndex, content: sub.trim() });
      chunkIndex++;
    }
    pageNumber++;
  }

  return result;
}

module.exports = { chunkMarkdown };
