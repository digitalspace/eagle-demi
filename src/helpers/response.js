'use strict';

const { logger } = require('../utils/logger');

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
 * The service's message can quote the `$filter`, ACL clause included, so it reaches the log only.
 * Null for an error that is not the search service's.
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
 * A 500 that logs the detail and tells the caller nothing: a Cosmos SDK message names the account
 * endpoint, database and container, and unauthenticated read routes surface it.
 */
function serverError(res, err, context) {
  logger.error(context || 'Unhandled error', {
    error: err && err.message,
    stack: err && err.stack
  });
  return res.status(500).json({ success: false, error: 'Internal server error.' });
}

module.exports = {
  sendError,
  serverError,
  searchServiceReply,
  searchServiceError
};
