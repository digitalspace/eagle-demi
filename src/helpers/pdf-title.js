'use strict';

/**
 * Which rows get their public name written into the stored PDF's title, and when the `pdfTitle`
 * record says that work is done or must be undone. Pure reads of the row; no store access.
 */

const { pdfTitleFor } = require('./file-name');
const { levelOfRead, isDemiSeal } = require('./access-sql');

// A Mongo ObjectId as `String(_id)` writes it: 24 lowercase hex characters.
const EAGLE_ID = /^[0-9a-f]{24}$/;

// Printable ASCII, single inner spaces: pdfTitleFor returns such a name unchanged (file-name.test.js).
// `\z`, not `$`: the store's PCRE `$` also matches before a final newline.
const CLEAN_SAFE = '^[!-~]+( [!-~]+)*\\z';

/**
 * Drops in the store only rows whose record already holds today's title, a name pdfTitleFor would
 * keep as is. Every term is guarded: a comparison with a missing field is undefined, and NOT of it drops the row.
 */
const PENDING_WHERE = 'WHERE LENGTH(c.id) = 24 AND IS_DEFINED(c.s3Key) ' +
  "AND (ARRAY_CONTAINS(c.read, 'public') OR c.pdfTitle.status = 'titled') " +
  'AND NOT (IS_STRING(c.s3Key) AND IS_STRING(c.pdfTitle.sourceKey) AND c.pdfTitle.sourceKey = c.s3Key ' +
  'AND IS_STRING(c.displayName) AND NOT IS_DEFINED(c.vis.displayName) ' +
  'AND RegexMatch(c.displayName, @cleanSafe) ' +
  'AND ((IS_STRING(c.pdfTitle.title) AND c.pdfTitle.title = c.displayName) ' +
  'OR (IS_STRING(c.pdfTitle.skippedTitle) AND c.pdfTitle.skippedTitle = c.displayName)))';

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

/** This file carries a title the public may not read any more. A replaced file was never titled. */
function needsRestore(doc) {
  const record = doc && doc.pdfTitle;
  return Boolean(record) && typeof record === 'object' &&
    record.status === 'titled' &&
    Boolean(doc.s3Key) && record.sourceKey === doc.s3Key &&
    pdfTitleFor(doc) === null;
}

/** Sealed by DEMI or by Eagle (level 0): its bytes are never handed to the worker unasked. */
function isSealed(row) {
  return isDemiSeal(row) || levelOfRead(row.read) === 0;
}

/**
 * Seed and Eagle push write `id` as the Mongo ObjectId, while every caller-reachable create uses
 * `crypto.randomUUID()` and no update can change `id`, so a 24-hex id means Eagle set the key.
 */
function isFromEagle(row) {
  return EAGLE_ID.test(String(row.id));
}

/** Why a row may not be titled, or null when it may. Size and shared key need the store and a query. */
function ineligibleReason(row) {
  if (isSealed(row)) return 'sealed';
  if (!isPdf(row)) return 'not-pdf';
  if (!row.s3Key) return 'no-file';
  if (levelOfRead(row.read) !== 4) return 'not-public';
  if (pdfTitleFor(row) === null) return 'no-public-name';
  return isEligible(row) ? null : 'not-eligible';
}

/** `title` when the row wants a title written, `restore` when its title must come out, else null. */
function modeFor(row) {
  if (isSealed(row)) return null;
  if (needsRestore(row)) return 'restore';
  if (isEligible(row) && !isCurrent(row)) return 'title';
  return null;
}

module.exports = {
  isPdf, isEligible, isCurrent, needsRestore, isSealed, isFromEagle, ineligibleReason, modeFor,
  PENDING_WHERE, CLEAN_SAFE
};
