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

/** RFC 6266: a plain ASCII name for old clients, plus the real one as UTF-8. */
function contentDisposition(fileName) {
  const name = String(fileName == null ? '' : fileName).replace(UNSAFE, '').trim() || 'download';
  const ascii = name.replace(NON_ASCII, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

module.exports = { contentDisposition };
