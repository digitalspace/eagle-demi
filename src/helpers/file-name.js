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

// Left-to-right overrides and isolates let a name render as something other than what extracts.
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// A real extension, not "the text after the last dot". The letter is what rules out `.2`.
const EXTENSION = /^\.[A-Za-z0-9]{1,8}$/;
const isExtension = ext => EXTENSION.test(ext) && /[A-Za-z]/.test(ext);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Strip dots and whitespace from both ends: Windows drops a trailing one when it extracts. */
const trimEnds = value => value.replace(/^[\s.]+|[\s.]+$/g, '');

/**
 * Strip separators, characters Windows refuses, control and bidi characters, dots and spaces at
 * either end. A lone surrogate becomes U+FFFD, so a Content-Disposition can URI-encode the name.
 */
function clean(value) {
  return trimEnds(String(value == null ? '' : value)
    .toWellFormed()
    .replace(CONTROL, '')
    .replace(/[/\\<>:"|?*]/g, '')
    .replace(BIDI, ''));
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
    String(doc.id);
  const ext = extensionOf(name, shown.fileExt) || extensionOf(clean(fallback));
  const base = ext && name.toLowerCase().endsWith(ext.toLowerCase())
    ? name.slice(0, -ext.length)
    : name;
  // A cut between the halves of a surrogate pair leaves a string encodeURIComponent throws on.
  const cut = base.slice(0, Math.max(1, MAX_NAME_LENGTH - ext.length)).replace(/[\uD800-\uDBFF]$/, '');
  return trimEnds(cut) + ext;
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
    .replace(BIDI, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

module.exports = { clean, fileNameFor, pdfTitleFor, trimEnds };
