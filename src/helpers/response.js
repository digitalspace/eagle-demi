'use strict';

const { logger } = require('../utils/logger');

/**
 * Send standardized success response
 */
function sendSuccess(res, data, statusCode = 200, extra = {}) {
  return res.status(statusCode).json({
    success: true,
    data,
    ...extra
  });
}

/**
 * Send standardized error response
 */
function sendError(res, error, statusCode = 500) {
  const message = typeof error === 'string' ? error : (error && error.message ? error.message : 'Internal Server Error');
  return res.status(statusCode).json({
    success: false,
    error: message
  });
}

const SEARCH_REFUSED = 'The search service could not run this query.';
const SEARCH_FAILED = 'The search service is unavailable.';

/**
 * What the caller sees of a search-service failure, or null for any other error. The service's
 * message can quote the `$filter`, the caller's ACL clause included, so it reaches the log only.
 * Its 400 answers to a query built from the caller's input; anything else is the service's fault.
 */
function searchServiceReply(err) {
  if (!err || !err.searchService) return null;
  return err.status === 400 ? { status: 400, error: SEARCH_REFUSED } : { status: 502, error: SEARCH_FAILED };
}

/** Answers a search-service failure with a fixed message and logs its detail; null for any other error. */
function searchServiceError(res, err, context) {
  const reply = searchServiceReply(err);
  if (!reply) return null;
  logger.warn(`${context}: search service failed`, { status: err.status, error: err.message, stack: err.stack });
  return res.status(reply.status).json({ error: reply.error });
}

/**
 * A 500 that logs the detail and tells the caller nothing.
 *
 * `sendError` echoes `error.message`, which is right for a 400 the caller caused and wrong for a
 * driver fault: a Cosmos SDK message carries the account endpoint, the database and container
 * names, and RU/status detail — and the read routes that surface it are reachable with no
 * credential at all. The detail still reaches the log stream, which is where it is useful.
 */
function serverError(res, err, context) {
  logger.error(context || 'Unhandled error', {
    error: err && err.message,
    stack: err && err.stack
  });
  return res.status(500).json({ success: false, error: 'Internal server error.' });
}

module.exports = {
  sendSuccess,
  sendError,
  serverError,
  searchServiceReply,
  searchServiceError
};
