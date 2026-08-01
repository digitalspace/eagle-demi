'use strict';

const { authenticate } = require('../helpers/auth');

/**
 * Passive auth: populate req.user when credentials are valid, otherwise continue as
 * anonymous. Used on public read routes, where visibility is enforced by the read ACL
 * (see helpers/access-sql.js for Cosmos reads, helpers/access-odata.js for AI Search) rather
 * than by rejecting the request.
 *
 * A REJECTED credential is not the same as no credential — log it, so a forged or expired
 * token is distinguishable from a logged-out visitor.
 */
module.exports = (req, res, next) => {
  authenticate(
    req,
    (user) => {
      req.user = user;
      return next();
    },
    (status, error) => {
      const presented = req.header('Authorization') || req.header('X-Api-Key');
      if (presented) {
        console.warn(
          `[passiveAuth] Rejected credential on ${req.method} ${req.originalUrl || req.url} ` +
          `(${status}: ${error}). Continuing as anonymous.`
        );
      }
      return next();
    }
  );
};
