'use strict';

const { authenticate } = require('../helpers/auth');
const { logger } = require('../utils/logger');
const { maskIds } = require('./http-logger');

/**
 * Public reads continue as anonymous on a bad credential; the read ACL limits what they see. A 5xx,
 * and in `strict` a rejected Bearer, is answered so the client retries instead of reading the public view.
 */
function passiveAuth({ rejectBearer = false } = {}) {
  return (req, res, next) => {
    authenticate(
      req,
      (user) => {
        req.user = user;
        return next();
      },
      (status, error) => {
        const bearer = String(req.header('Authorization') || '').startsWith('Bearer ');
        // An outage says nothing about the credential, so a keyed caller retries instead of reading the public view.
        const refuse = status >= 500 || (rejectBearer && bearer);

        const presented = req.header('Authorization') || req.header('X-Api-Key');
        if (presented) {
          logger.warn(
            `[passiveAuth] Rejected credential on ${req.method} ${maskIds(req.originalUrl || req.url)} ` +
            `(${status}: ${error}). ${refuse ? `Answering ${status}.` : 'Continuing as anonymous.'}`
          );
        }
        if (refuse) return res.status(status).json({ error });
        return next();
      }
    );
  };
}

module.exports = passiveAuth();
module.exports.strict = passiveAuth({ rejectBearer: true });
