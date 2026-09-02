'use strict';

/**
 * The sort key behind `displayNameSort`.
 *
 * AI Search orders strings by codepoint, so "Item 10" sorts before "Item 2" and an "Item 100" ahead
 * of both. Sortable index fields are never analyzed and Cosmos SQL has no regex or zero-pad, so the
 * key is computed here and stored on the row (src/seed/transform.js and the three document write
 * paths in src/controllers/nosql/document.js).
 */

/**
 * Digits per run. Covers every number an EAO document title carries — a longer run is left whole,
 * which orders it after every padded one rather than truncating it into the wrong place.
 */
const DIGIT_WIDTH = 12;

/** `'Item 2'` → `'item 000000000002'`. `''` for a row with no name. */
function naturalSortKey(name) {
  if (name === null || name === undefined) return '';
  return String(name)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    // "(Draft) Appendix" and "- Appendix" must land beside "Appendix", not ahead of every letter.
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\d+/g, run => run.padStart(DIGIT_WIDTH, '0'));
}

module.exports = { naturalSortKey, DIGIT_WIDTH };
