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
 * token is distinguishable from a logged-out visitor. `strict` (the native kind routes) answers a
 * rejected Bearer with its 401 instead, so a client refreshes rather than reading the public view
 * under a 200. The default stays lenient: the existing public reads serve clients that may still
 * send a stale token.
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
        if (rejectBearer && bearer) return res.status(status).json({ error });

        const presented = req.header('Authorization') || req.header('X-Api-Key');
        if (presented) {
          logger.warn(
            `[passiveAuth] Rejected credential on ${req.method} ${req.originalUrl || req.url} ` +
            `(${status}: ${error}). Continuing as anonymous.`
          );
        }
        return next();
      }
    );
  };
}

module.exports = passiveAuth();
module.exports.strict = passiveAuth({ rejectBearer: true });
