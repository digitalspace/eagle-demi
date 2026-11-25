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

/**
 * Display markup for one selected field. Unlike `snippetFrom`, an unmatched field falls back to its
 * escaped value, so the caller binds one string and escaping happens once, here.
 */
function markedField(hit, field) {
  const fragments = (hit['@search.highlights'] || {})[field] || [];
  if (fragments.length > 0) return fragments.map(balanceFragment).join(' … ');

  const raw = hit[field];
  return raw === undefined || raw === null ? '' : escapeHtml(String(raw));
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
