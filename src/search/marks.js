'use strict';

// Highlights land inside untrusted PDF text the frontend renders as HTML. Control chars no
// document can hold mark them; the whole fragment is escaped, then they become <mark>.
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
  // Balanced per fragment: a fragment cut can land inside a highlight and orphan a sentinel.
  return highlights.map(balanceFragment).join(' … ');
}

/** The `filename` tokenizer's split (azure/search/indexes), kept as a capture so `split` keeps both sides. */
const TOKEN_SPLIT = /([A-Za-z0-9]+)/;
const MARKED_SPAN = new RegExp(`${HL_PRE}([^${HL_PRE}${HL_POST}]*)${HL_POST}`, 'g');

/**
 * Display markup for one selected field. Unlike `snippetFrom`, an unmatched field falls back to its
 * escaped value, so the caller binds one string and escaping happens once, here.
 */
function markedField(hit, field) {
  const highlights = hit['@search.highlights'] || {};
  const fragments = highlights[field] || [];
  if (fragments.length > 0) return fragments.map(balanceFragment).join(' … ');

  const raw = hit[field];
  if (raw === undefined || raw === null) return '';
  // A word en.microsoft drops (`mine`) matches only in the `<field>Tokens` copy. Its marked words
  // mark the field's own text, so no copy text reaches the output.
  const tokens = new Set((highlights[`${field}Tokens`] || []).flatMap(fragment =>
    [...fragment.matchAll(MARKED_SPAN)].flatMap(([, span]) => span.toLowerCase().split(TOKEN_SPLIT))));
  return String(raw).split(TOKEN_SPLIT)
    .map((part, i) => (i % 2 === 1 && tokens.has(part.toLowerCase()) ? `<mark>${part}</mark>` : escapeHtml(part)))
    .join('');
}

/**
 * Escapes, then turns sentinels into balanced `<mark>` tags: an orphan closer is dropped and an
 * open mark is closed at the end, so an innerHTML snippet cannot break the layout around it.
 */
function balanceFragment(fragment) {
  let depth = 0;
  let out = '';
  for (const ch of escapeHtml(fragment)) {
    if (ch === HL_PRE) { depth++; out += '<mark>'; }
    else if (ch === HL_POST) { if (depth > 0) { depth--; out += '</mark>'; } }
    else out += ch;
  }
  return out + '</mark>'.repeat(depth);
}

module.exports = { HL_PRE, HL_POST, snippetFrom, markedField };
