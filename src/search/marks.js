'use strict';

// Highlights land inside untrusted PDF text the frontend renders as HTML. Control chars no
// document can hold mark them; each piece is escaped, then marked ones become <mark>.
const HL_PRE = '\u0001';
const HL_POST = '\u0002';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/** Escape first, mark second. '' without highlights: chunk `content` is never selected. */
function snippetFrom(hit) {
  const highlights = (hit['@search.highlights'] && hit['@search.highlights'].content) || [];
  if (highlights.length === 0) return '';
  return highlights.map(markFragment).join(' … ');
}

/** The `filename` tokenizer's split (azure/search/indexes), kept as a capture so `split` keeps both sides. */
const TOKEN_SPLIT = /([A-Za-z0-9]+)/;
const SENTINEL_SPLIT = new RegExp(`([${HL_PRE}${HL_POST}])`);

/**
 * A fragment as `{ text, marked }` pieces. The service drops a marker at either fragment edge, so
 * text before a leading closer is marked, and an opener marks to the next marker or the end.
 */
function readSpans(fragment) {
  const parts = String(fragment).split(SENTINEL_SPLIT);
  return parts.flatMap((text, i) => (i % 2 === 1 || text === ''
    ? []
    : [{ text, marked: i === 0 ? parts[1] === HL_POST : parts[i - 1] === HL_PRE }]));
}

/**
 * Display markup for one selected field. Unlike `snippetFrom`, an unmatched field falls back to its
 * escaped value, so the caller binds one string and escaping happens once, here.
 */
function markedField(hit, field) {
  const highlights = hit['@search.highlights'] || {};
  const fragments = highlights[field] || [];
  if (fragments.length > 0) return fragments.map(markFragment).join(' … ');

  const raw = hit[field];
  if (raw === undefined || raw === null) return '';
  // A word en.microsoft drops (`mine`) matches only in the `<field>Tokens` copy. Its marked words
  // mark the field's own text, so no copy text reaches the output.
  const tokens = new Set((highlights[`${field}Tokens`] || []).flatMap(fragment =>
    readSpans(fragment).filter(span => span.marked).flatMap(span => span.text.toLowerCase().split(TOKEN_SPLIT))));
  return String(raw).split(TOKEN_SPLIT)
    .map((part, i) => (i % 2 === 1 && tokens.has(part.toLowerCase()) ? `<mark>${part}</mark>` : escapeHtml(part)))
    .join('');
}

/** Each piece escaped, marked pieces wrapped, so a fragment's tags always balance in innerHTML. */
function markFragment(fragment) {
  return readSpans(fragment)
    .map(({ text, marked }) => (marked ? `<mark>${escapeHtml(text)}</mark>` : escapeHtml(text)))
    .join('');
}

module.exports = { HL_PRE, HL_POST, snippetFrom, markedField };
