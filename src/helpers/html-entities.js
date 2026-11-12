'use strict';

/**
 * HTML entities to characters and markup to plain text, for the federal registry reader, the
 * eagle-notify sender and the Updates mirror.
 */

/** The punctuation entities that show up in registry markup and in editor-written Update content. */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°'
};

/**
 * Accented letters by name: BC is bilingual and Nations are named in their own orthography
 * ("Stk'eml&uacute;psemc te Secw&eacute;pemc"), so an escape left in place reaches a reader.
 */
const LOWER_LETTERS = {
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î',
  iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü'
};

/** The same letters both ways round, because `&Eacute;` is a different letter from `&eacute;`. */
const NAMED_LETTERS = Object.entries(LOWER_LETTERS).reduce((all, [name, letter]) => {
  all[name] = letter;
  all[name[0].toUpperCase() + name.slice(1)] = letter.toUpperCase();
  return all;
}, {});

/**
 * Controls other than tab, LF and CR, surrogates and noncharacters are not text; fromCodePoint
 * throws past U+10FFFF. A numeric entity for any of them stays as written.
 */
function isText(code) {
  if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return false;
  if (code < 0x20) return code === 0x09 || code === 0x0A || code === 0x0D;
  if (code >= 0x7F && code <= 0x9F) return false;
  return !(code >= 0xFDD0 && code <= 0xFDEF) && (code & 0xFFFE) !== 0xFFFE;
}

/** Numeric and named entities decoded; an entity this table does not know is left as written. */
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return isText(code) ? String.fromCodePoint(code) : whole;
    }
    // Letters are matched as written; the punctuation entities are not case-sensitive.
    if (Object.hasOwn(NAMED_LETTERS, body)) return NAMED_LETTERS[body];
    const lower = body.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : whole;
  });
}

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u180e\u202a-\u202e\u2060\u2066-\u2069\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;

/**
 * Text without bidi embeddings, overrides and isolates (U+202E reverses what follows), invisible
 * format characters, or controls but tab, LF and CR. U+200E, U+200F, U+061C, U+200B and U+00AD stay.
 */
const withoutControls = text => (typeof text === 'string' ? text.replace(CONTROLS, '') : text);

/** `withoutControls`, or null when controls were all the text held. */
function withoutControlsOrNull(text) {
  const kept = withoutControls(text);
  return kept === '' && text !== '' ? null : kept;
}

/** Tags that end a block of text: `<li>One</li><li>Two</li>` reads "One Two", not "OneTwo". */
const BLOCK_TAG = /<\/?(?:br|p|div|li|ul|ol|h[1-6]|blockquote|tr|td|th|table|section|article)\b[^>]*>/gi;

/** `pattern` replaced only up to the last `>`: no tag closes past it, and a scan there is quadratic. */
function replaceTags(text, pattern, replacement) {
  const end = text.lastIndexOf('>') + 1;
  return text.slice(0, end).replace(pattern, replacement) + text.slice(end);
}

/** Tags removed until none is left, so a split tag (`<<b>script>`) cannot rejoin into one. */
function withoutTags(html) {
  let text = html;
  let previous;
  do {
    previous = text;
    text = replaceTags(text, /<[^>]*>/g, '');
  } while (text !== previous);
  return text;
}

/**
 * Markup to one line of plain text. No `<` or `>` survives, not even one decoded from `&lt;`, so
 * the result can never carry a tag.
 */
function plainTextOf(html) {
  // Block tags break words; any other tag is inline (`<i>`), so it goes without a space.
  return withoutControls(decodeEntities(withoutTags(replaceTags(String(html || ''), BLOCK_TAG, ' '))))
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { decodeEntities, plainTextOf, replaceTags, withoutControls, withoutControlsOrNull };
