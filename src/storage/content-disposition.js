'use strict';

/**
 * The `Content-Disposition` a download URL is signed with — one implementation, because both
 * backends bake it into the signature and a header that differs between them is a bug only one
 * environment shows.
 *
 * Safari ignores `download` on a cross-origin <a>, so the URL itself has to say attachment.
 */

// Quote and backslash break the quoted-string; control characters (CR and LF included) split the
// header. Neither is escapable inside a value that gets signed, so both are removed.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f"\\]/g;
const NON_ASCII = /[^\x20-\x7e]/g;

/**
 * RFC 6266: a plain ASCII name for old clients, plus the real one as UTF-8. A lone surrogate, which
 * encodeURIComponent throws on, becomes U+FFFD.
 */
function contentDisposition(fileName, { inline = false } = {}) {
  const name = String(fileName == null ? '' : fileName).toWellFormed().replace(UNSAFE, '').trim() ||
    'download';
  const ascii = name.replace(NON_ASCII, '_');
  const type = inline ? 'inline' : 'attachment';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// HTML or SVG shown from the store's origin would run script there, so neither is listed. PDF risk
// is accepted: the signed `application/pdf` type means a PDF/HTML polyglot never renders as HTML,
// and PDF script runs only inside the viewer's sandbox.
const INLINE_BY_EXT = new Map([
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp']
]);
const INLINE_TYPES = new Set(INLINE_BY_EXT.values());
// Recorded types that say only "some bytes", so the extension decides instead.
const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/x-download']);

/**
 * The type to sign an inline URL with, or null when the file must stay an attachment. The recorded
 * MIME type decides; the file extension stands in only when it is missing or a generic binary type.
 */
function inlineType(mimeType, fileName) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (mime && !GENERIC_TYPES.has(mime)) return INLINE_TYPES.has(mime) ? mime : null;
  const ext = /\.([^./]+)$/.exec(String(fileName || ''));
  return (ext && INLINE_BY_EXT.get(ext[1].toLowerCase())) || null;
}

module.exports = { contentDisposition, inlineType };
