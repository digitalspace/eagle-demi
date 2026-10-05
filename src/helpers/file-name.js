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

/** Strip what a file or zip entry path must not carry: separators, control and bidi characters, dots. */
function clean(value) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, '')
    .replace(BIDI, '')
    .replace(/^\.+/, '')
    .trim();
}

/** The recorded type wins: `Application Report v1.2` has no extension, whatever extname says. */
function extensionOf(name, fileExt) {
  const declared = `.${clean(fileExt).replace(/^\.+/, '')}`;
  if (isExtension(declared)) return declared;
  const found = path.extname(name);
  return isExtension(found) ? found : '';
}

/**
 * A file name for a document, from what THIS caller may see of it: the row goes through the field
 * redactor first, so a title withheld at the caller's level cannot arrive as a file name instead.
 * `fallback` names a row redacted down to nothing and lends its extension to a name that has none;
 * with no fallback the id names it, which is public by definition.
 */
function fileNameFor(doc, access, fallback = '') {
  const shown = redactForAccess('documents', doc, access);
  const name = clean(shown.documentFileName || shown.displayName || '') || clean(fallback) ||
    String(doc.id);
  const ext = extensionOf(name, shown.fileExt) || extensionOf(clean(fallback));
  const base = ext && name.toLowerCase().endsWith(ext.toLowerCase())
    ? name.slice(0, -ext.length)
    : name;
  return base.slice(0, Math.max(1, MAX_NAME_LENGTH - ext.length)) + ext;
}

module.exports = { clean, fileNameFor };
