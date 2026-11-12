'use strict';

/** Whole seconds: Last-Modified and the dates compared against it carry no finer precision. */
function httpSeconds(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** RFC 9110 13.1.2/13.1.3: a weak comparison against our one tag; If-None-Match beats the date. */
function notModified(req, etag, lastModified) {
  const tags = req.headers['if-none-match'];
  if (tags) {
    return tags.trim() === '*' || tags.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag);
  }
  const since = httpSeconds(req.headers['if-modified-since']);
  // RFC 9110 13.1.3: a date in the future is invalid, so it cannot vouch for the copy.
  return since !== null && since <= Date.now() / 1000 && httpSeconds(lastModified) <= since;
}

const UNSATISFIABLE = 'unsatisfiable';
const RANGE = /^bytes=[ \t]*(\d*)-(\d*)[ \t]*$/;

/**
 * The one byte range to send, `UNSATISFIABLE`, or null for the whole file. A malformed or
 * multi-part Range, or an If-Range that does not match this copy, is ignored as RFC 9110 14.2 allows.
 */
function byteRange(req, size, etag, lastModified) {
  const m = RANGE.exec(String(req.headers.range || ''));
  if (!m || (!m[1] && !m[2])) return null;

  const ifRange = req.headers['if-range'];
  if (ifRange) {
    const fresh = /^(W\/)?"/.test(ifRange)
      ? ifRange === etag
      : httpSeconds(ifRange) !== null && httpSeconds(ifRange) === httpSeconds(lastModified);
    if (!fresh) return null;
  }

  if (!m[1]) {
    const suffix = Number(m[2]);
    return suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : UNSATISFIABLE;
  }
  const start = Number(m[1]);
  const last = m[2] ? Number(m[2]) : Infinity;
  if (last < start) return null;
  return start < size ? { start, end: Math.min(last, size - 1) } : UNSATISFIABLE;
}

module.exports = { notModified, byteRange, UNSATISFIABLE, RANGE };
