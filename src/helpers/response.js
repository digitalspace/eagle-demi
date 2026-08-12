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
  serverError
};
