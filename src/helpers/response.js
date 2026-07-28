'use strict';

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

module.exports = {
  sendSuccess,
  sendError
};
