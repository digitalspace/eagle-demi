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

    const message = `${method} ${originalUrl} ${statusCode} - ${contentLength} B - ${timeMs}ms (IP: ${ip})`;

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
