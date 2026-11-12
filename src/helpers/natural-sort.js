'use strict';

/**
 * AI Search sorts by codepoint ("Item 10" before "Item 2") and Cosmos SQL cannot zero-pad, so the
 * `displayNameSort` key is built here and stored on the row by every document write.
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
