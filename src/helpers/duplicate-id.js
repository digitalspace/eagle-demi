'use strict';

/**
 * One id stored in more than one row where a write expects at most one. The write-path existence
 * reads throw it rather than pick a row: writing to either copy leaves the other one serving its
 * own ACL, and nothing tells the two apart.
 *
 * The mirrors answer 409, not a 5xx: eagle-api's push client retries a 500-and-up only, and a
 * retry finds the same rows.
 */

const { logger } = require('../utils/logger');
const { serverError } = require('./response');

const DUPLICATE_ID = 'DUPLICATE_ID';

/** Logs the id and where its copies live, never their content, and returns the error to throw. */
function duplicateIdError(container, id, partitionKeys) {
  logger.error(`[${container}] one id is stored in more than one row, refusing the write`,
    { container, id: String(id), partitionKeys });
  return Object.assign(new Error(`[${container}] ${id} is stored in more than one row`),
    { code: DUPLICATE_ID });
}

/** A mirror's catch-all: 409 for a duplicated id, otherwise the usual detail-free 500. */
function mirrorError(res, err, context) {
  if (err && err.code === DUPLICATE_ID) {
    return res.status(409).json({ error: 'This id is stored more than once. Nothing was written.' });
  }
  return serverError(res, err, context);
}

module.exports = { DUPLICATE_ID, duplicateIdError, mirrorError };
