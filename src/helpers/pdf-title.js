'use strict';

/**
 * Which rows get their public name written into the stored PDF's title, and when the `pdfTitle`
 * record says that work is done or must be undone. Pure reads of the row; no store access.
 */

const { pdfTitleFor } = require('./file-name');
const { levelOfRead } = require('./access-sql');

/** A PDF by its recorded type or its recorded extension. */
function isPdf(doc) {
  const mime = String(doc.mimeType || '').split(';')[0].trim().toLowerCase();
  const ext = String(doc.fileExt || '').replace(/^\.+/, '').trim().toLowerCase();
  return mime === 'application/pdf' || ext === 'pdf';
}

/**
 * Public by `read[]` (a sealed row is level 0, `isPublished` alone never counts), a PDF, a stored
 * file, a public name. Size cap and shared `s3Key` need a stat and a cross-row query: the caller's.
 */
function isEligible(doc) {
  if (!doc || typeof doc !== 'object') return false;
  return levelOfRead(doc.read) === 4 && isPdf(doc) && Boolean(doc.s3Key) && pdfTitleFor(doc) !== null;
}

/**
 * The record was made from this file under this name, whatever its status, or a retitle to this
 * name was refused (`skippedTitle`), so it is not tried again.
 */
function isCurrent(doc) {
  const record = doc && doc.pdfTitle;
  if (!record || typeof record !== 'object' || !doc.s3Key || record.sourceKey !== doc.s3Key) return false;
  const wanted = pdfTitleFor(doc);
  return record.title === wanted || (Boolean(record.skippedTitle) && record.skippedTitle === wanted);
}

/** This file carries a title the public may no longer read. A replaced file was never titled. */
function needsRestore(doc) {
  const record = doc && doc.pdfTitle;
  return Boolean(record) && typeof record === 'object' &&
    record.status === 'titled' &&
    Boolean(doc.s3Key) && record.sourceKey === doc.s3Key &&
    pdfTitleFor(doc) === null;
}

module.exports = { isPdf, isEligible, isCurrent, needsRestore };
