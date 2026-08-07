'use strict';

const { logger } = require('../utils/logger');

module.exports = (req, res, next) => {
  const start = process.hrtime();

  // Capture completion event of response to log metrics
  res.on('finish', () => {
    const diff = process.hrtime(start);
    const timeMs = ((diff[0] * 1e9 + diff[1]) / 1e6).toFixed(2);
    const { method, originalUrl } = req;
    const ip = req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
    const { statusCode } = res;
    const contentLength = res.get('Content-Length') || 0;

    // Caller identity. This middleware runs BEFORE any auth middleware, but the finish handler
    // fires after, so req.user is populated by the time this closure reads it. Without this a
    // request log could not answer "which consumer did that?" — the question that matters the
    // moment more than one service holds a credential.
    //
    // keyId is the PUBLIC half of a registry key and is safe to log; the secret never appears
    // anywhere. Anonymous requests log as 'anonymous' rather than being left blank, so an absent
    // identity is visibly absent rather than looking like a logging bug.
    const principal = (req.user && req.user.preferred_username) || 'anonymous';
    const credential = req.user && req.user.keyId
      ? ` key=${req.user.keyId}`
      : (req.user && req.user.azp ? ` client=${req.user.azp}` : '');

    const message = `${method} ${originalUrl} ${statusCode} - ${contentLength} B - ${timeMs}ms ` +
      `(IP: ${ip}, as: ${principal}${credential})`;

    if (statusCode >= 500) {
      logger.error(message);
    } else if (statusCode >= 400) {
      logger.warn(message);
    } else {
      logger.info(message);
    }
  });

  next();
};
