'use strict';

/**
 * The name a document's bytes are saved under — one implementation for the single download and
 * the bulk zip entries, so a file is called the same thing whichever way it was fetched.
 */

const path = require('path');
const { redactForAccess } = require('../vis/redact');

// A zip folder + name has to clear the 255-character path limit Windows Explorer still enforces
// when it extracts, with room for the drive and the extract directory the caller chose.
const MAX_NAME_LENGTH = 150;

// Bidi controls make a name render as other than what extracts; the rest render as nothing. U+200C
// and U+200D stay for scripts and emoji. Combining marks sit outside a class, where lint allows them.
const INVISIBLE = /[\u180b-\u180f]|\u034f|\u17b4|\u17b5|[\u1160\u00ad\u061c\u115f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u2800\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{1d173}-\u{1d17a}]/gu;

// Windows opens the device, not a file, whatever extension follows the name.
const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

// A real extension, not "the text after the last dot". The letter is what rules out `.2`.
const EXTENSION = /^\.[A-Za-z0-9]{1,8}$/;
const isExtension = ext => EXTENSION.test(ext) && /[A-Za-z]/.test(ext);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// Old zip tools map `．＼` to `.\` when extracting, so a look-alike of a character the rules below
// strip becomes that character first. Other compatibility forms (`¹`, `ﬁ`) stay as written.
const STRIPPED = '/\\<>:"|?*.';
const foldLookAlikes = value => value.replace(/[\u0080-\uffff]/g, char => {
  const folded = char.normalize('NFKC');
  return folded.length === 1 && STRIPPED.includes(folded) ? folded : char;
});

/** Strip dots and whitespace from both ends: Windows drops a trailing one when it extracts. */
function trimEnds(value) {
  // A loop, not `[\s.]+$`: that pattern rescans a long inner run once per character.
  let start = 0;
  let end = value.length;
  while (start < end && /[\s.]/.test(value[start])) start += 1;
  while (end > start && /[\s.]/.test(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/** At most `max` UTF-16 units, no half of a surrogate pair, no dot or space at either end, no device name. */
function fitName(value, max) {
  // A cut between the halves of a surrogate pair leaves a string encodeURIComponent throws on.
  const name = trimEnds(value.slice(0, max).replace(/[\uD800-\uDBFF]$/, ''));
  return DEVICE.test(name.split('.')[0].trimEnd()) ? `_${name}` : name;
}

/**
 * Strip separators, characters Windows refuses, control and invisible characters, dots and spaces
 * at either end. A lone surrogate becomes U+FFFD, so a Content-Disposition can URI-encode the name.
 */
function clean(value) {
  return trimEnds(foldLookAlikes(String(value == null ? '' : value).toWellFormed())
    .replace(CONTROL, '')
    // cp932 and cp949 put `¥` and `₩` where `\` is; best-fit maps U+2216 to `\` and U+2236 to `:`.
    .replace(/[/\\<>:"|?*\u00a5\u20a9\u2215\u2216\u2236\u2044]/g, '')
    .replace(INVISIBLE, '')
    .replace(/\s{2,}/g, ' '));
}

/** The recorded type wins: `Application Report v1.2` has no extension, whatever extname says. */
function extensionOf(name, fileExt) {
  const declared = `.${clean(fileExt)}`;
  if (isExtension(declared)) return declared;
  const found = path.extname(name);
  return isExtension(found) ? found : '';
}

/**
 * A file name from what THIS caller may see: a withheld title cannot return as a file name. `fallback`
 * names a row redacted to nothing and lends its extension; without it the public id names it.
 */
function fileNameFor(doc, access, fallback = '') {
  const shown = redactForAccess('documents', doc, access);
  const name = clean(shown.documentFileName || shown.displayName || '') || clean(fallback) ||
    clean(doc.id) || 'document';
  const ext = extensionOf(name, shown.fileExt) || extensionOf(clean(fallback));
  const base = ext && name.toLowerCase().endsWith(ext.toLowerCase())
    ? name.slice(0, -ext.length)
    : name;
  return fitName(base, Math.max(1, MAX_NAME_LENGTH - ext.length)) + ext;
}

/**
 * The title written into a PDF: the display name an anonymous visitor sees, on one line, or null
 * when they see none (a `vis` dial can withhold it). A title is no path, so slashes stay.
 */
function pdfTitleFor(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const name = redactForAccess('documents', doc, {}).displayName;
  return String(name == null ? '' : name)
    .replace(CONTROL, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

module.exports = { clean, fileNameFor, fitName, pdfTitleFor };
