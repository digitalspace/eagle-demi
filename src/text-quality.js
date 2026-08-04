'use strict';

/**
 * text-quality.js — the artefact heuristics, in one place.
 *
 * These were written for `src/scripts/audit-chunk-quality.js`, which grades text ALREADY in the
 * corpus. The chunker now needs two of the same judgements at ingest time, and a second copy of
 * thresholds tuned against the real corpus is how the audit and the cleaner quietly stop agreeing
 * — the audit would report a defect the cleaner believes it removed. So they live here and both
 * callers import them.
 *
 * WHAT THESE ARE NOT. They are cheap syntactic signals, not a verdict on quality; the audit script
 * says so at length and it is worth repeating at the point of reuse. The only honest measure of a
 * search corpus is whether a human-visible phrase retrieves its own document — that is
 * `score-retrieval.js`. Nothing here should ever be used to decide that text is "bad enough" to
 * drop, with the single exception documented on `isSeparatorFurniture()`.
 *
 * Known blind spot, measured rather than assumed: character-spacing damage — real corpus text
 * reading `Tum ble r Ridge` — scores CLEAN. Every fragment is pronounceable and none is vowelless.
 * Catching it needs a dictionary or a bigram model this deliberately does not carry.
 */

// docling emits this for every picture; there is no way to turn it off (image_export_mode admits
// only placeholder/embedded/referenced), so it is stripped or tolerated, never prevented.
const IMAGE_PLACEHOLDER = /<!--\s*image\s*-->/gi;
const VOWEL = /[aeiouy]/i;

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Remove docling's image placeholders and tidy the whitespace they leave behind.
 *
 * Returns '' when a section was nothing but placeholders, which is the case worth handling: those
 * sections carry no words at all, so an index entry made from one matches nothing and occupies a
 * result slot.
 *
 * @param {string} text
 * @returns {string}
 */
function stripPlaceholders(text) {
  return String(text || '')
    .replace(IMAGE_PLACEHOLDER, ' ')
    // Collapse the runs of spaces and the blank lines a removed placeholder leaves, without
    // joining paragraphs that were genuinely separate.
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();
}

/**
 * Metrics for one chunk of text.
 *
 * Every ratio is over the chunk AFTER placeholders are removed, so a chunk that is half image
 * placeholders is not also scored as having poor letter density — that would count one defect
 * twice and make the thresholds impossible to reason about.
 */
function measure(text) {
  const raw = String(text || '');
  const placeholders = (raw.match(IMAGE_PLACEHOLDER) || []).length;
  const body = raw.replace(IMAGE_PLACEHOLDER, ' ');
  const length = raw.length;

  const letters = (body.match(/[A-Za-z]/g) || []).length;
  const digits = (body.match(/[0-9]/g) || []).length;
  const nonAscii = (body.match(/[^\x20-\x7E\s]/g) || []).length;

  const tokens = body.split(/\s+/).filter(Boolean);
  const shortTokens = tokens.filter(tok => tok.replace(/[^A-Za-z0-9]/g, '').length <= 2);

  // PURELY ALPHABETIC tokens only. Measured against the real corpus: identifiers like `PH12-3-3`
  // and units like `3E-06` are legitimately vowelless, and counting them made a hydrology data
  // table score identically to OCR word-salad (vowelless 0.27 vs 0.24) — the two were
  // indistinguishable on every cheap metric until digits were excluded here.
  const words = tokens
    .map(tok => tok.replace(/[^A-Za-z0-9]/g, ''))
    .filter(tok => tok.length >= 3 && /^[A-Za-z]+$/.test(tok));
  const vowelless = words.filter(w => !VOWEL.test(w));

  // Tabular text is legitimately fragmented and letter-poor. Detected so the fragmentation rules
  // can exempt it rather than reporting a quality crisis made of perfectly good tables.
  //
  // BOTH forms, because the first version only knew pipe tables and duly flagged a table of
  // earthquake records (`56.98  -122.26  1.0  2.2  No  119 km WNW of…`) as OCR debris. Columns
  // separated by whitespace are still columns.
  const lines = body.split('\n').filter(l => l.trim());
  const pipeLines = lines.filter(l => (l.match(/\|/g) || []).length >= 2).length;
  const numericLines = lines.filter(l => (l.match(/(^|\s)-?\d+(\.\d+)?(?=\s|$)/g) || []).length >= 3).length;
  const tabular = lines.length > 0 && (pipeLines + numericLines) / lines.length >= 0.5;

  const denom = Math.max(body.replace(/\s/g, '').length, 1);
  const maxRepeat = (body.match(/(.)\1{3,}/g) || [])
    .reduce((longest, run) => Math.max(longest, run.length), 0);

  // How much of the chunk is separator furniture — dot leaders, rules, form underscores.
  //
  // The LENGTH of the longest run is the wrong measure and produced a 29% garbage rate that was
  // mostly false: a table of contents in a perfectly clean document carries a 100-character dot
  // leader, and a document is not damaged for having one. What matters is whether the chunk is
  // MOSTLY furniture, so this is a share, not a maximum.
  const separatorChars = (body.match(/[.\-_=·•*]{4,}/g) || [])
    .reduce((total, run) => total + run.length, 0);
  const separatorRatio = round(separatorChars / denom);

  return {
    length,
    placeholders,
    // Share of the ORIGINAL chunk that was placeholder markup rather than text.
    placeholderRatio: length ? round((length - body.trim().length) / length) : 0,
    alphaRatio: round(letters / denom),
    digitRatio: round(digits / denom),
    nonAsciiRatio: round(nonAscii / denom),
    tokenCount: tokens.length,
    wordCount: words.length,
    tabular,
    meanTokenLength: tokens.length ? round(tokens.join('').length / tokens.length) : 0,
    shortTokenRatio: tokens.length ? round(shortTokens.length / tokens.length) : 0,
    vowellessRatio: words.length ? round(vowelless.length / words.length) : 0,
    maxRepeatRun: maxRepeat,
    separatorRatio
  };
}

/**
 * Classify a chunk and say WHY.
 *
 * The reasons matter more than the label: "which artefact, how often" is what decides whether the
 * fix belongs in OCR settings, in the chunker, or nowhere. A label alone would collapse three
 * different problems into one number.
 *
 * The digit exemption is deliberate. Tables of measurements are legitimately low on letters and
 * high on digits, and they are perfectly findable content — scoring them as garbage would
 * manufacture a problem and then "fix" real data out of the index.
 */
function classify(m) {
  const reasons = [];

  if (m.placeholderRatio > 0.5) reasons.push('mostly-image-placeholders');
  // The load-bearing signal. Vowelless ALPHABETIC words are what OCR debris is made of, and
  // nothing legitimate produces them in bulk — 0.2 sits between the measured corpus garbage
  // (0.24 after excluding identifiers) and clean prose (0.0).
  if (m.wordCount >= 5 && m.vowellessRatio > 0.2) reasons.push('vowelless-tokens');
  if (m.nonAsciiRatio > 0.15) reasons.push('non-ascii-noise');
  // Furniture AND letter-poor, both. Separator share alone still condemned tables of contents —
  // measured on the corpus, a real TOC page runs separatorRatio 0.40-0.58 while carrying
  // alphaRatio 0.37-0.56, because it is mostly SECTION TITLES with dot leaders between them.
  // Those titles are findable content; the page is not damaged. What is actually junk (a chunk
  // that is nothing but a horizontal rule) has almost no letters at all.
  if (m.separatorRatio > 0.3 && m.alphaRatio < 0.35) reasons.push('mostly-separator-furniture');
  // Both fragmentation rules exempt tables, which are legitimately letter-poor and chopped up.
  if (!m.tabular && m.shortTokenRatio > 0.5) reasons.push('fragmented-tokens');
  if (!m.tabular && m.alphaRatio < 0.5 && m.digitRatio < 0.3) reasons.push('low-letter-density');

  if (reasons.length > 0) return { verdict: 'garbage', reasons };

  if (m.placeholderRatio > 0.2) reasons.push('some-image-placeholders');
  if (m.separatorRatio > 0.1) reasons.push('some-separator-furniture');
  if (m.wordCount >= 5 && m.vowellessRatio > 0.1) reasons.push('some-vowelless-tokens');
  if (!m.tabular && m.shortTokenRatio > 0.35) reasons.push('some-fragmented-tokens');
  if (!m.tabular && m.meanTokenLength > 0 && m.meanTokenLength < 3) {
    reasons.push('very-short-tokens');
  }

  if (reasons.length > 0) return { verdict: 'marginal', reasons };
  return { verdict: 'clean', reasons };
}

/**
 * Is this chunk nothing but rules, dot leaders and form underscores?
 *
 * The ONLY classifier reason the chunker acts on, and the restraint is the point. `classify()`
 * also reports vowelless tokens, fragmented tokens and low letter density — all of which describe
 * DAMAGED TEXT, which is still text. Dropping those at ingest would delete the OCR corpus's
 * hardest documents from the index and turn a measurable extraction problem into an invisible one.
 * Separator furniture is different in kind: it carries no words to retrieve, so a chunk made of it
 * can never be the right answer to any query, and keeping it only spends an index entry.
 *
 * The `alphaRatio < 0.35` half of the rule is what makes this safe: a table of contents is mostly
 * dot leaders BY SHARE but carries section titles, which are findable content, and it is kept.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isSeparatorFurniture(text) {
  return classify(measure(text)).reasons.includes('mostly-separator-furniture');
}

module.exports = {
  IMAGE_PLACEHOLDER,
  VOWEL,
  round,
  stripPlaceholders,
  measure,
  classify,
  isSeparatorFurniture
};
