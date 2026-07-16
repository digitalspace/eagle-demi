'use strict';

const crypto = require('crypto');
const { runWithRequestId } = require('../utils/logger');

module.exports = (req, res, next) => {
  // Extract from incoming headers if already provided (e.g. from upstream reverse proxies or eagle-api)
  let requestId = req.header('x-request-id') || req.header('x-correlation-id');

  // Fallback to generating a clean, short 8-char trace ID if none provided
  if (!requestId) {
    requestId = crypto.randomUUID().substring(0, 8);
  }

  // Attach directly to request object for downstream inspection
  req.id = requestId;

  // Set response headers so client/caller can trace the request
  res.setHeader('X-Request-ID', requestId);

  // Execute the remainder of the request execution chain within AsyncLocalStorage context
  runWithRequestId(requestId, next);
};
