'use strict';

/**
 * HTML entities to the characters they stand for. Shared by the federal registry reader and the
 * eagle-notify sender: both turn stored markup into plain text a person reads.
 */

/** The punctuation entities that show up in registry markup and in editor-written Update content. */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°'
};

/**
 * Accented letters, written by name. BC is bilingual and Nations are named in their own
 * orthography — "Stk'eml&uacute;psemc te Secw&eacute;pemc" — so leaving these escaped quotes the
 * escape back at a reader.
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

/** Numeric and named entities decoded; an entity this table does not know is left as written. */
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // fromCodePoint throws past U+10FFFF, and one bad entity must not fail the whole text.
      return Number.isFinite(code) && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
    }
    // Letters are matched as written; the punctuation entities are not case-sensitive.
    const named = NAMED_LETTERS[body] !== undefined
      ? NAMED_LETTERS[body]
      : NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

module.exports = { decodeEntities };
