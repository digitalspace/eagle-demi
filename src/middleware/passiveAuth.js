'use strict';

const { authenticate } = require('../helpers/auth');
const { logger } = require('../utils/logger');

/**
 * Passive auth: populate req.user when credentials are valid, otherwise continue as
 * anonymous. Used on public read routes, where visibility is enforced by the read ACL
 * (see helpers/access-sql.js for Cosmos reads, helpers/access-odata.js for AI Search) rather
 * than by rejecting the request.
 *
 * A REJECTED credential is not the same as no credential — log it, so a forged or expired
 * token is distinguishable from a logged-out visitor. `strict` (GET /me, the native kind routes
 * and the by-id reads) also answers a rejected Bearer with its 401, so a client refreshes rather
 * than reading the public view under a 200. The default stays lenient on the routes not yet moved.
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
        const refuse = rejectBearer && bearer;

        const presented = req.header('Authorization') || req.header('X-Api-Key');
        if (presented) {
          logger.warn(
            `[passiveAuth] Rejected credential on ${req.method} ${req.originalUrl || req.url} ` +
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
