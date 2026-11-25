'use strict';

/**
 * Words the analyzer drops: a `~1` or `*` variant of one asks for a literal the index lacks, and
 * one such clause zeroes the AND. Errs wide: a wrong entry only costs one prefix expansion.
 */
const ANALYZER_STOPWORDS = new Set([
  // Measured on the live index: `searchChunks({ keywords: word, fuzzy: false })` counts 0.
  'from', 'hers', 'herself', 'himself', 'itself', 'mine', 'myself', 'ours', 'ourselves', 'that',
  'their', 'theirs', 'them', 'themselves', 'these', 'they', 'this', 'those', 'with', 'yourself',
  // Standard English stop set, inferred from en.microsoft; the Analyze API is 403 to the app.
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it',
  'no', 'not', 'of', 'on', 'or', 'such', 'the', 'then', 'there', 'to', 'was', 'will'
]);

/** The one check every `~1` or `*` append goes through. */
function isAnalyzerStopword(term) {
  return ANALYZER_STOPWORDS.has(term.toLowerCase());
}

module.exports = { isAnalyzerStopword };
