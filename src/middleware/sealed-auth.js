'use strict';

const { authenticate } = require('../helpers/auth');

/**
 * Verification only, deliberately not `middleware/auth.js`: its AUTHENTICATED_ROLES excludes `compliance`,
 * the sealed compartment's only caller. `requireRole('compliance')` beside it decides who gets in.
 */
module.exports = (req, res, next) => {
  authenticate(
    req,
    (user) => { req.user = user; return next(); },
    (status, error) => res.status(status).json({ error })
  );
};
